// path: src/api/filing/middlewares/block-filingstatus.ts
/**
 * Block direct edits to `filingStatus` on generic create/update requests.
 * Forces callers to use: /filings/:id/(submit|advance|finalize).
 */
export default (_config: unknown, _ctxDeps: { strapi: any }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    const method = String(ctx.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return next();
    }

    const raw = ctx.request?.body ?? {};
    const data =
      raw && typeof raw === 'object' && 'data' in raw ? (raw as any).data : raw;

    if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'filingStatus')) {
      return ctx.badRequest(
        'Direct edits to filingStatus are not allowed. Use /filings/:id/submit, /filings/:id/advance, or /filings/:id/finalize.'
      );
    }

    await next();
  };
};
