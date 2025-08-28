/* eslint-disable @typescript-eslint/no-explicit-any */
// Access the global Strapi instance without importing types
declare const strapi: any;

const ok = (ctx: any, extra: Record<string, unknown> = {}) => {
  ctx.body = { status: 'ok', ...extra };
};

export default {
  async index(ctx: any) {
    ok(ctx);
  },

  async liveness(ctx: any) {
    ok(ctx);
  },

  async readiness(ctx: any) {
    let db = 'unknown';
    try {
      const conn = strapi?.db?.connection; // knex instance
      if (conn) await conn.raw('select 1');
      db = 'ok';
    } catch {
      db = 'error';
      ctx.status = 503; // signal "not ready"
    }
    ok(ctx, { checks: { db } });
  },
};
