// src/api/realtime-sse/controllers/realtime-sse.ts
import type { Context } from 'koa';

const parseTopics = (ctx: Context, userId: number) => {
  const q = ctx.query as any;
  const topics: string[] = [`user:${userId}`];
  if (q.projectId) topics.push(`project:${q.projectId}`);
  if (q.filingId)  topics.push(`filing:${q.filingId}`);
  if (q.filingId && q.questionId) topics.push(`question:${q.filingId}:${q.questionId}`);
  if (q.filingId && q.questionId && q.answerRevisionId) topics.push(`question:${q.filingId}:${q.questionId}:${q.answerRevisionId}`);
  return topics;
};

export default ({ strapi }) => ({
  async stream(ctx: Context) {
  const user = (ctx.state as any).user;
  if (!user) return void ctx.unauthorized();

  const projectRef = typeof ctx.query.projectId === 'string' && ctx.query.projectId.trim()
    ? ctx.query.projectId.trim()
    : undefined;

  const topics = parseTopics(ctx, user.id);
  await strapi.service('api::realtime-sse.guard').assertCanSubscribe(user, topics, projectRef);

  // Take over the response
  ctx.req.setTimeout(0);
  ctx.respond = false;
  const res = ctx.res;

  const write = (msg: { id: string; event: string; data: any }) => {
    if (res.writableEnded) return;
    res.write(`id: ${msg.id}\n`);
    res.write(`event: ${msg.event}\n`);
    res.write(`data: ${JSON.stringify(msg.data)}\n\n`);
  };

  const pubsub = strapi.service('api::realtime-sse.pubsub');

  // Subscribe first so we can expose subId
  const subId = pubsub.subscribe(topics, write);
  pubsub.tagSubscriber(subId, Number(user.id));
  pubsub.registerCloser(subId, () => {
    clearInterval(hb);
    try { res.end(); } catch {}
  });

  // Set headers *after* we know subId, *before* any writes
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-SSE-Sub-Id': subId,                // ← expose subId as a header
  });

  // Priming comment to flush some proxies/clients
  res.write(':\n\n');

  // Emit "open" with subId so the client can store it
  write({
    id: String(Date.now()),
    event: 'open',
    data: { subId, topics, at: new Date().toISOString() },  // ← include subId here
  });

  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(`event: heartbeat\ndata: {}\n\n`);
  }, 15000);

  ctx.req.on('close', async () => {
    clearInterval(hb);
    strapi.service('api::realtime-sse.pubsub').unsubscribe(subId);
    try { res.end(); } catch {}
  });
},



// NEW: unsubscribe one or more topics on a specific subscription (keeps the SSE open if others remain)
  async unsubscribe(ctx: Context) {
    const user = (ctx.state as any).user;
    if (!user) return void ctx.unauthorized();

    const subId = String(ctx.params.id || '');

    const want: string[] = Array.isArray(ctx.request.body?.topics)
      ? (ctx.request.body.topics as unknown[])
          .map(String)
          .map(s => s.trim())
          .filter((s): s is string => s.length > 0)
      : [];

    if (!subId) return void ctx.badRequest('Missing :id');
    if (!want.length) return void ctx.badRequest('Provide topics[] as a non-empty array');

    const bus: any = strapi.service('api::realtime-sse.pubsub');

    // Privileged roles may manage any sub; others must own the sub
    const role = String(user?.role?.name ?? '').trim().toLowerCase();
    const isPrivileged = role === 'admin' || role === 'administrator' || role === 'auditor';
    if (!isPrivileged) {
      if (typeof bus.isOwnedBy !== 'function') return void ctx.throw(500, 'Ownership check unavailable');
      if (!bus.isOwnedBy(subId, Number(user.id))) return void ctx.forbidden('Not your subscription');
    }

    // Only remove topics that are actually on this subscription (avoid info leaks)
    const current = (typeof bus.getTopics === 'function' ? bus.getTopics(subId) : []) as string[];
    const currentSet = new Set<string>(current);

    // Make TS sure these are strings
    const uniqueWant: string[] = Array.from(new Set<string>(want));

    const toRemove: string[] = uniqueWant.filter((topic) => currentSet.has(topic));

    // Nothing to do (already unsubscribed or wrong topics)
    if (!toRemove.length) {
      ctx.body = { ok: true, subId, removed: [] };
      return;
    }

    // Partial unsubscribe (your pubsub supports: unsubscribe(id, topics?))
    bus.unsubscribe(subId, toRemove);

    // Optional: report remaining topics (if available)
    const remaining = (typeof bus.getTopics === 'function' ? bus.getTopics(subId) : undefined) as string[] | undefined;

    ctx.body = { ok: true, subId, removed: toRemove, remaining };
  },

  async subscribe(ctx) {
    const user = (ctx.state as any).user;
    if (!user) return void ctx.unauthorized();

    const subId = String(ctx.params.id || '');
    const pubsub = strapi.service('api::realtime-sse.pubsub') as any;

    // Ownership: only the user who owns this sub may mutate it
    if (!pubsub.isOwnedBy?.(subId, Number(user.id))) {
      return ctx.forbidden('Subscription does not belong to you');
    }

    const body = (ctx.request.body ?? {}) as any;
    const bodyTopics  = Array.isArray(body.topics) ? body.topics.map((t: any) => String(t ?? '').trim()).filter(Boolean) : [];
    const queryTopics = parseTopics(ctx, Number(user.id)); // ← your helper, unchanged

    // Union + dedupe
    const requested = Array.from(new Set<string>([...bodyTopics, ...queryTopics]));
    if (!requested.length) return ctx.badRequest('Provide topics in body and/or as query params');

    // Determine which are actually new
    const existing = new Set<string>(pubsub.getTopics?.(subId) ?? []);
    const toAdd    = requested.filter(t => !existing.has(t));
    const already  = requested.filter(t =>  existing.has(t));

    if (!toAdd.length) {
      ctx.body = { id: subId, added: [], already, now: pubsub.getTopics?.(subId) ?? [] };
      return;
    }

    // Match stream’s guard usage exactly
    const projectRef = (typeof ctx.query.projectId === 'string' && ctx.query.projectId.trim())
      ? ctx.query.projectId.trim()
      : undefined;

    try {
      await strapi.service('api::realtime-sse.guard').assertCanSubscribe(user, toAdd, projectRef);
    } catch (err: any) {
      return ctx.forbidden(err?.message || 'Not authorized to subscribe to one or more topics');
    }

    // Attach newly authorized topics (pubsub.addTopics is the tiny helper you added)
    const { added } = pubsub.addTopics(subId, toAdd);

    ctx.body = {
      id: subId,
      added,
      already,
      now: pubsub.getTopics?.(subId) ?? [],
    };
  }

});
