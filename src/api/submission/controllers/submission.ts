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
}));
