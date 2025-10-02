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

    const result = await strapi
      .service('api::answer-revision.answer-revision')
      .saveDraftWithModelScore({
        filingDocumentId,
        questionDocumentId,
        userId,
        answerText,
      });

    // 👉 Return only the trio (no sanitizeOutput/transform of the large object)
    const draft = (result as any)?.draft ?? {};
    const lean = {
      modelScore: draft?.modelScore ?? null,
      modelReason: draft?.modelReason ?? null,
      modelSuggestion: draft?.modelSuggestion ?? null,
    };

    // Strapi helper to wrap as { data: ... }
    return this.transformResponse(lean);
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
    async update(ctx) {
      const UID = 'api::answer-revision.answer-revision';
      const documentId = String(ctx.params.id);

      // 1) Capture "prev" BEFORE the core update (to get relation IDs reliably)
      let prev: any = null;
      try {
        prev = await strapi.documents(UID).findOne({
          documentId,
          fields: ['documentId'],
          populate: {
            filing:   { fields: ['documentId'] },
            question: { fields: ['documentId'] },
          },
        } as any);
      } catch { /* ignore */ }

      // 2) Perform the normal update
      const res = await super.update(ctx);

      // 3) ALWAYS emit only the fields that were actually updated in this request
      const rawBody = (ctx.request?.body ?? {}) as any;
      const data = 'data' in rawBody ? rawBody.data : rawBody;

      const ALLOWED = new Set([
        'answerText',
        'modelScore',
        'modelReason',
        'modelSuggestion',
        'auditorScore',
        'auditorReason',
        'auditorSuggestion',
      ]);

      const sentKeys = Object.keys(data || {}).filter((k) => ALLOWED.has(k));

      if (sentKeys.length > 0) {
        // Resolve channel IDs
        const revisionId = documentId;
        let filingId     = String(prev?.filing?.documentId ?? '');
        let questionId   = String(prev?.question?.documentId ?? '');

        if (!filingId || !questionId) {
          try {
            const populated: any = await strapi.documents(UID).findOne({
              documentId,
              fields: ['documentId'],
              populate: { filing: true, question: true },
            } as any);
            filingId   = filingId   || String(populated?.filing?.documentId   || '');
            questionId = questionId || String(populated?.question?.documentId || '');
          } catch { /* ignore */ }
        }

        if (filingId && questionId) {
          const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
          const str = (v: unknown) => (v == null ? null : String(v));

          const payload: any = {
            documentId: revisionId,
            updatedAt: new Date().toISOString(),
          };

          for (const k of sentKeys) {
            if (k === 'auditorScore' || k === 'modelScore') payload[k] = num(data[k]);
            else payload[k] = str(data[k]);
          }

          const topic = `question:${filingId}:${questionId}:${revisionId}`;
          const event = 'question:answer:state';
          const msgId = `${event}:${revisionId}:${Date.now()}`;

          try {
            await strapi.service('api::realtime-sse.pubsub').publish(topic, msgId, event, payload);
          } catch (err) {
            strapi.log?.warn?.(`[sse][answer-revision.update] publish failed: ${err?.message ?? err}`);
          }
        } else {
          strapi.log?.warn?.(
            '[sse][answer-revision.update] missing IDs; skip emit doc=%s filing=%s question=%s',
            revisionId, filingId, questionId
          );
        }
      }

      // 4) Return the normal response
      return res;
    },

    // GET /filings/:filingId/questions/:questionId/lean-with-draft/from/:order?take=3
async leanWithDraftFromOrder(ctx) {
  const filingDocumentId   = String(ctx.params?.filingId || '').trim();
  const questionDocumentId = String(ctx.params?.questionId || '').trim();
  const fromOrderRaw       = (ctx.params?.order ?? '').toString();
  const fromOrder          = Number(fromOrderRaw);

  if (!filingDocumentId || !questionDocumentId) {
    ctx.throw(400, 'filingId and questionId are required path params');
  }
  if (!Number.isFinite(fromOrder)) {
    ctx.throw(400, 'order must be a valid number');
  }

  const take = Math.max(1, Math.min(20, Number((ctx.query as any)?.take ?? 3)));

  // Fixed whitelist of lean question fields
  const questionFields = [
    'id',
    'documentId',
    'header',
    'subheader',
    'prompt',
    'example',
    'guidanceMarkdown',
    'maxScore',
    'questionType',
    'order', // used internally for sort/verification (not required in output if you don’t want it)
  ];

  const rows = await strapi
    .service('api::answer-revision.answer-revision')
    .getLeanWithDraftFromOrder({
      filingDocumentId,
      questionDocumentId,
      fromOrder,
      take,
      questionFields,
      userId: ctx.state?.user?.id ?? null,
    });

  // Rows are already shape-limited; just pass through the standard transformer for consistency.
  return this.transformResponse(rows);
}



  })
);
