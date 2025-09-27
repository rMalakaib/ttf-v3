// src/api/realtime-sse/controllers/realtime-sse.ts
import type { Context } from 'koa';
import { randomUUID } from "node:crypto";

const parseTopics = (ctx: Context, userId: number) => {
  const q = ctx.query as any;
  const topics: string[] = [`user:${userId}`];
  if (q.projectId) topics.push(`project:${q.projectId}`);
  if (q.filingId)  topics.push(`filing:${q.filingId}`);
  if (q.filingId && q.questionId) topics.push(`question:${q.filingId}:${q.questionId}`);
  if (q.filingId && q.questionId && q.answerRevisionId) topics.push(`question:${q.filingId}:${q.questionId}:${q.answerRevisionId}`);
  return topics;
};

// --- BEGIN compat helpers (drop these near the top of the file) ------------
function subscribeCompat(
  bus: any,
  res: any,
  subId: string,
  userId: number,
  topics: string[]
) {
  const attempts: Array<() => any> = [
    () => bus.subscribe(res, { subId, userId, topics }),     // object shape
    () => bus.subscribe(res, [subId, userId, topics]),       // tuple/array shape
    () => bus.subscribe(res, subId, userId, topics),         // positional
    () => bus.subscribe(res, topics),                        // minimal legacy
  ];

  let lastErr: unknown;
  for (const tryIt of attempts) {
    try {
      const out = tryIt();
      // Optional: uncomment for one-time visibility
      // console.log("[SSE] subscribeCompat: used variant", attempts.indexOf(tryIt));
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("pubsub.subscribe signature mismatch");
}

function unsubscribeCompat(bus: any, res: any, subId: string) {
  const attempts: Array<() => any> = [
    () => bus.unsubscribe(res),                // by response handle
    () => bus.unsubscribe(subId),              // by subId
    () => bus.unsubscribe(res, subId),         // mixed
  ];

  for (const tryIt of attempts) {
    try { return tryIt(); } catch {}
  }
  // If none worked, just ignore; stream is ending anyway.
}
// --- END compat helpers -----------------------------------------------------


const PAD_BYTES = 2048;

const writeSseEvent = (res: any, event: string, data?: any, id?: string) => {
  try {
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    if (data !== undefined) res.write(`data: ${JSON.stringify(data)}\n`);
    res.write("\n");
  } catch {}
};

const writeComment = (res: any, text: string) => {
  try { res.write(`: ${text}\n\n`); } catch {}
};

const withTimeout = async <T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> => {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(label)), ms)));
  try { return await Promise.race([p, timeout]) as T; }
  finally { clearTimeout(t!); }
};


export default ({ strapi }) => ({
async stream(ctx: Context) {
  const user = (ctx.state as any)?.user;
  if (!user) return void ctx.unauthorized();

  // Take over immediately
  ctx.respond = false;
  const res = ctx.res;

  // ⚠️ Write headers directly via Node to avoid any Koa buffering issues
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "identity",
  });

  // Force a flush at the edge with a BIG prelude (~64KB)
  // Many proxies won’t forward tiny SSE frames; this defeats buffering.
  try {
    const padChunk = ": " + " ".repeat(8190) + "\n\n"; // ~8KB per chunk
    for (let i = 0; i < 8; i++) res.write(padChunk);   // ~64KB total
  } catch {}

  // Handshake + heartbeat BEFORE any awaits
  const subId = randomUUID();
  writeSseEvent(res, "server-handshake", { subId, at: new Date().toISOString() });

  const hb = setInterval(() => {
    // comment lines are safe and ignored by clients
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 15000);

  // Only the user topic
  const topics: string[] = [`user:${Number(user.id)}`];

  // Guard (timeboxed). If it fails, WARN but don’t close (avoid reconnect storms).
  try {
    await withTimeout(
      strapi.service("api::realtime-sse.guard").assertCanSubscribe(user, topics),
      4000,
      "guard-timeout"
    );
  } catch (e: any) {
    writeSseEvent(res, "warning", { message: e?.message || "guard-failed" });
  }

  // Subscribe using your existing pubsub (unchanged) via compat bridge
  const bus: any = strapi.service("api::realtime-sse.pubsub");
  const userId = Number(user.id);
  let subscribed = false;

  try {
    subscribeCompat(bus, res, subId, userId, topics);
    subscribed = true;
    writeSseEvent(res, "subscribed", { subId, topics, at: new Date().toISOString() });
  } catch (e: any) {
    // Keep stream alive; client won’t auto-reconnect
    writeSseEvent(res, "warning", {
      message: "not-subscribed (pubsub signature mismatch)",
      detail: String(e?.message || e),
    });
  }

  // Cleanup
  ctx.req.on("close", () => {
    clearInterval(hb);
    if (subscribed) {
      try { unsubscribeCompat(bus, res, subId); } catch {}
    }
    try { res.end(); } catch {}
  });
}
,





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
