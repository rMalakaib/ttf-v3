// Streams plain text in 2 chunks with a pause.
// If your client doesn't see the first chunk immediately, the platform is buffering.
import type { Context } from "koa";

export default () => ({
  async test(ctx: Context) {
    ctx.set("Content-Type", "text/plain; charset=utf-8");
    ctx.set("Cache-Control", "no-cache, no-transform");
    ctx.set("X-Accel-Buffering", "no");
    ctx.status = 200;
    ctx.respond = false;

    const res = ctx.res;
    res.flushHeaders?.();

    // chunk #1
    res.write("first-chunk\n");

    // wait 2s
    await new Promise(r => setTimeout(r, 2000));

    // chunk #2, then end
    res.write("second-chunk\n");
    res.end();
  },
});
