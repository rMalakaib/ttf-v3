// path: src/api/framework-version/controllers/framework-version.ts
import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::framework-version.framework-version', ({ strapi }) => ({
  async find(ctx) {
    const { results, pagination } = await strapi
      .service('api::framework-version.framework-version')
      .find(ctx.query);

    const sanitized = await this.sanitizeOutput(results, ctx);
    return this.transformResponse(sanitized, { pagination });
  },

  async findOne(ctx) {
    const { id: documentId } = ctx.params;

    const entity = await strapi
      .service('api::framework-version.framework-version')
      .findOne(documentId, ctx.query);

    const sanitized = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitized);
  },

  // GET /api/framework-versions/:id/questions
   async listQuestionsForVersion(ctx) {
    const { id: versionDocumentId } = ctx.params;

    const query: any = {
      filters: { framework_version: { documentId: versionDocumentId } },
      sort: ['order:asc'],
      fields: ['order', 'prompt', 'guidanceMarkdown', 'maxScore', 'example', 'modelPrompt'] as const,
    };

    // Allow caller to pass through pagination / fields / populate if they want
    const { pagination, fields, populate } = (ctx.query as any) || {};
    if (pagination) query.pagination = pagination;
    if (fields) query.fields = fields;
    if (populate) query.populate = populate;

    const questions = await strapi.documents('api::question.question').findMany(query);

    const sanitized = await this.sanitizeOutput(questions, ctx);
    return this.transformResponse(sanitized);
  },
    // GET /api/framework-versions/:id/filings
    // Returns: filing id, filing slug, and the related project's slug
   async listFilingsForVersion(ctx) {
    const { id: versionDocumentId } = ctx.params;

    const query: any = {
        filters: { framework_version: { documentId: versionDocumentId } },
        fields: ['id', 'slug'],
        populate: {
        project: { fields: ['slug'] },
        },
        // optional: let callers override sort/pagination via querystring
        ...(ctx.query?.sort ? { sort: (ctx.query as any).sort } : {}),
        ...(ctx.query?.pagination ? { pagination: (ctx.query as any).pagination } : {}),
    };

    const filings = await strapi.documents('api::filing.filing').findMany(query);

    const sanitized = await this.sanitizeOutput(filings, ctx);
    return this.transformResponse(sanitized);
   },
}));
