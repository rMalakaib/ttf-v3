import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::submission.submission', ({ strapi }) => ({
  async latestSubmissionScore(ctx) {
    const documentId = ctx.params?.id;
    if (!documentId) return ctx.badRequest('Missing filing documentId');

    // Get the latest submission by round number (desc), then submittedAt (desc)
    const sub = await strapi.documents('api::submission.submission').findFirst({
      publicationState: 'preview',
      filters: { filing: { documentId } },
      fields: ['documentId', 'number', 'score', 'submittedAt'] as any,
      sort: ['number:desc', 'submittedAt:desc'],
    } as any);

    if (!sub) return ctx.notFound('No submissions found for this filing');

    const scoreNum = sub.score == null ? 0 : Number(sub.score);
    ctx.body = {
      filingDocumentId: documentId,
      submissionDocumentId: sub.documentId,
      submissionNumber: sub.number,
      score: Number.isFinite(scoreNum) ? scoreNum : 0,
      submittedAt: sub.submittedAt ?? null,
    };
  },

   /**
   * GET /filings/:filingDocumentId/submissions/:number/questions/:questionDocumentId/answer-revision
   */
  async answerRevisionForQuestion(ctx) {
    const { filingDocumentId, number, questionDocumentId } = ctx.params;

    const submissionNumber = Number.parseInt(String(number), 10);
    if (!Number.isFinite(submissionNumber) || submissionNumber < 1) {
      return ctx.badRequest('Invalid "number" param: must be an integer >= 1');
    }

    // Delegate to service
    const answerRevision = await strapi
      .service('api::submission.submission')
      .findAnswerRevisionForQuestion({
        filingDocumentId: String(filingDocumentId),
        submissionNumber,
        questionDocumentId: String(questionDocumentId),
        previewFallback: true, // if the answer_revision was never published, still return it
      });

    if (!answerRevision) {
      return ctx.notFound('AnswerRevision not found for the given filing/submission/question');
    }

    // You can sanitize/transform if you prefer; returning raw is fine for internal APIs.
    ctx.body = answerRevision;
  },
}));
