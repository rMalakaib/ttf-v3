// Strapi v5 / Koa — minimal SSE smoke test (safe to delete later)
import type { Context } from "koa";
import { randomUUID } from "node:crypto";

export default ({ strapi }) => ({
  async test(ctx: Context) {
    // Require auth by default (route can override if you want it public)
    const user = (ctx.state as any)?.user;
    if (!user) return void ctx.unauthorized();

    // --- Take over the response immediately
    ctx.set("Content-Type", "text/event-stream; charset=utf-8");
    ctx.set("Cache-Control", "no-cache, no-transform");
    ctx.set("Connection", "keep-alive");
    ctx.set("X-Accel-Buffering", "no");
    ctx.status = 200;
    ctx.respond = false;

    const res = ctx.res;
    res.flushHeaders?.(); // flush headers right now

    // Initial comment so proxies send headers
    res.write(`: open ${Date.now()}\n\n`);

    // Handshake event with a fresh subId
    const subId = randomUUID();
    res.write(
      `event: server-handshake\n` +
      `data: ${JSON.stringify({ subId, at: new Date().toISOString() })}\n\n`
    );

    // Heartbeat to avoid idle timeouts on the origin
    const hb = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
    }, 15000);

    // Clean up on disconnect
    ctx.req.on("close", () => {
      clearInterval(hb);
      try { res.end(); } catch {}
    });
  },
});
