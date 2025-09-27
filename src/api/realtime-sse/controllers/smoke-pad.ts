// Strapi v5 — minimal SSE padding smoke test
import type { Context } from "koa";
import { randomUUID } from "node:crypto";

export default ({ strapi }) => ({
  async test(ctx: Context) {
    ctx.set("Content-Type", "text/event-stream; charset=utf-8");
    ctx.set("Cache-Control", "no-cache, no-transform");
    ctx.set("Connection", "keep-alive");
    ctx.set("X-Accel-Buffering", "no");
    ctx.set("Content-Encoding", "identity");
    ctx.status = 200;
    ctx.respond = false;

    const res = ctx.res;
    res.flushHeaders?.();

    // 2KB pad to defeat proxy buffering
    res.write(": " + " ".repeat(2048) + "\n");

    const subId = randomUUID();
    res.write(
      "event: server-handshake\n" +
      `data: ${JSON.stringify({ subId, at: new Date().toISOString() })}\n\n`
    );

    const hb = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
    }, 15000);

    ctx.req.on("close", () => {
      clearInterval(hb);
      try { res.end(); } catch {}
    });
  },
});
