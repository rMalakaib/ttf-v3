// path: src/api/answer-revision/controllers/answer-revision.ts
import { factories } from '@strapi/strapi';

/**
 * Step 10 — AnswerRevision (Drafting) controller
 * - Thin controller: parameter parsing + delegation to services + response shaping.
 * - Heavy logic lives in the service (draft creation, ChatGPT scoring, recompute filing.currentScore).
 *
 * Expected service methods on: api::answer-revision.answer-revision
 * - getOrCreateDraft({ filingDocumentId, questionDocumentId, userId })
 * - saveDraftWithModelScore({ filingDocumentId, questionDocumentId, userId, answerText })
 * - listRevisions({ filingDocumentId, questionDocumentId })
 */
export default factories.createCoreController(
  'api::answer-revision.answer-revision',
  ({ strapi }) => ({
    // GET /filings/:filingId/questions/:questionId/draft
    async getDraft(ctx) {
      const filingDocumentId = String(ctx.params?.filingId || '').trim();
      const questionDocumentId = String(ctx.params?.questionId || '').trim();
      if (!filingDocumentId || !questionDocumentId) {
        ctx.throw(400, 'filingId and questionId are required path params');
      }

      const userId = ctx.state?.user?.id ?? null;

      const entity = await strapi
        .service('api::answer-revision.answer-revision')
        .getOrCreateDraft({ filingDocumentId, questionDocumentId, userId });

      const sanitized = await this.sanitizeOutput(entity, ctx);
      return this.transformResponse(sanitized);
    },

    // PUT /filings/:filingId/questions/:questionId/draft
    async saveDraft(ctx) {
      const filingDocumentId = String(ctx.params?.filingId || '').trim();
      const questionDocumentId = String(ctx.params?.questionId || '').trim();
      if (!filingDocumentId || !questionDocumentId) {
        ctx.throw(400, 'filingId and questionId are required path params');
      }

      // Accept either { data: { answerText } } or raw { answerText }
      const body = (ctx.request?.body ?? {}) as any;
      const data = 'data' in body ? body.data : body;
      const answerText = data?.answerText;

      if (typeof answerText !== 'string') {
        ctx.throw(400, 'answerText (string) is required');
      }

      const userId = ctx.state?.user?.id ?? null;

      // Service handles: draft resolution, ChatGPT scoring, conditional recompute of filing.currentScore
      const result = await strapi
        .service('api::answer-revision.answer-revision')
        .saveDraftWithModelScore({
          filingDocumentId,
          questionDocumentId,
          userId,
          answerText,
        });

      // result may be: { draft, updatedCurrentScore? }
      const sanitized = await this.sanitizeOutput(result, ctx);
      return this.transformResponse(sanitized);
    },

    // GET /filings/:filingId/questions/:questionId/revisions
    async listRevisions(ctx) {
      const filingDocumentId = String(ctx.params?.filingId || '').trim();
      const questionDocumentId = String(ctx.params?.questionId || '').trim();
      if (!filingDocumentId || !questionDocumentId) {
        ctx.throw(400, 'filingId and questionId are required path params');
      }

      const rows = await strapi
        .service('api::answer-revision.answer-revision')
        .listRevisions({ filingDocumentId, questionDocumentId });

      const sanitized = await this.sanitizeOutput(rows, ctx);
      return this.transformResponse(sanitized);
    },
  })
);
