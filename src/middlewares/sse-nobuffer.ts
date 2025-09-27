// src/middlewares/sse-nobuffer.ts
import type { Context, Next } from "koa";

/**
 * Disable compression/buffering for SSE endpoints so the first chunk flushes.
 * Safe to keep or remove later.
 */
export default () => {
  return async (ctx: Context, next: Next) => {
    // Adjust this prefix if your base path differs
    const isSse = ctx.path.startsWith("/api/realtime-sse");

    if (isSse) {
      // Prevent intermediaries from buffering/transforming
      ctx.set("Cache-Control", "no-cache, no-transform");
      ctx.set("X-Accel-Buffering", "no");

      // Some compression middlewares look at this
      (ctx as any).noCompression = true;

      // Koa-compress 'filter' may still run; we’ll also gate it below in config
    }

    await next();
  };
};
