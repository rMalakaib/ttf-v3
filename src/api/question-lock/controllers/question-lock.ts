// QuestionLock controller (strict TTL locks).
// TTL defaults to 12s; override with env QUESTION_LOCK_TTL_SECONDS.

import { factories } from '@strapi/strapi';

const TTL_SECONDS = Math.max(1, Number(process.env.QUESTION_LOCK_TTL_SECONDS ?? 12));

export default factories.createCoreController('api::question-lock.question-lock', ({ strapi }) => ({
  // POST /filings/:filingId/questions/:questionId/locks/acquire
  async acquire(ctx) {
    const filingDocumentId = String(ctx.params?.filingId || '').trim();
    const questionDocumentId = String(ctx.params?.questionId || '').trim();
    if (!filingDocumentId || !questionDocumentId) ctx.throw(400, 'filingId and questionId are required');

    const userId = ctx.state?.user?.id ?? null;
    if (!userId) ctx.throw(401, 'Authentication required');

    const lock = await strapi
      .service('api::question-lock.question-lock')
      .acquire({ filingDocumentId, questionDocumentId, userId, ttlSeconds: TTL_SECONDS });

    const sanitized = await this.sanitizeOutput(lock, ctx);
    return this.transformResponse({ status: 'ok', ttlSeconds: TTL_SECONDS, lock: sanitized });
  },

  // POST /filings/:filingId/questions/:questionId/locks/heartbeat
  async heartbeat(ctx) {
    const filingDocumentId = String(ctx.params?.filingId || '').trim();
    const questionDocumentId = String(ctx.params?.questionId || '').trim();
    if (!filingDocumentId || !questionDocumentId) ctx.throw(400, 'filingId and questionId are required');

    const userId = ctx.state?.user?.id ?? null;
    if (!userId) ctx.throw(401, 'Authentication required');

    const lock = await strapi
      .service('api::question-lock.question-lock')
      .heartbeat({ filingDocumentId, questionDocumentId, userId, ttlSeconds: TTL_SECONDS });

    const sanitized = await this.sanitizeOutput(lock, ctx);
    return this.transformResponse({ status: 'ok', ttlSeconds: TTL_SECONDS, lock: sanitized });
  },

  // POST /filings/:filingId/questions/:questionId/locks/release
  async release(ctx) {
    const filingDocumentId = String(ctx.params?.filingId || '').trim();
    const questionDocumentId = String(ctx.params?.questionId || '').trim();
    if (!filingDocumentId || !questionDocumentId) ctx.throw(400, 'filingId and questionId are required');

    const userId = ctx.state?.user?.id ?? null;
    if (!userId) ctx.throw(401, 'Authentication required');

    await strapi
      .service('api::question-lock.question-lock')
      .release({ filingDocumentId, questionDocumentId, userId });

    ctx.status = 204; // No Content
    return;
  },

  // GET /filings/:filingId/questions/:questionId/locks/status
  async status(ctx) {
    const filingDocumentId = String(ctx.params?.filingId || '').trim();
    const questionDocumentId = String(ctx.params?.questionId || '').trim();
    if (!filingDocumentId || !questionDocumentId) ctx.throw(400, 'filingId and questionId are required');

    const viewerId = ctx.state?.user?.id ?? null;

    const status = await strapi
      .service('api::question-lock.question-lock')
      .status({ filingDocumentId, questionDocumentId, viewerId });

    // status is a plain object; no entity sanitation needed
    return this.transformResponse(status);
  },
}));
