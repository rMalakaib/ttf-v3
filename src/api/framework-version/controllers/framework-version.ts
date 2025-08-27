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
      fields: ['header', 'subheader','order', 'prompt', 'guidanceMarkdown', 'maxScore', 'example', 'modelPrompt'] as const,
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
   /**
   * GET /framework-versions/:id/questions/lean
   * Lean index for a specific framework version.
   * Now includes: score (alias of maxScore), example, guidanceMarkdown.
   */
  async leanListByFrameworkVersion(ctx) {
    const { id: versionDocumentId } = ctx.params;

    // Ensure we fetch maxScore so we can expose "score"
    const q = ctx.query as any;
    const fields = q?.fields ?? [
      'id',
      'order',
      'header',
      'subheader',
      'prompt',
      'example',
      'guidanceMarkdown',
      'maxScore',
    ];
    const sort = q?.sort ?? ['order:asc'];
    const pagination = q?.pagination ?? { pageSize: 500 };

    const entities = await strapi.documents('api::question.question').findMany({
      filters: { framework_version: { documentId: versionDocumentId } },
      fields,
      sort,
      populate: [],
      pagination,
    });

    // Sanitize first, then add computed "score" and optionally hide "maxScore"
    const sanitized = await this.sanitizeOutput(entities, ctx);
    const withScore = Array.isArray(sanitized)
      ? sanitized.map(({ maxScore, ...rest }) => ({ ...rest, score: maxScore }))
      : sanitized;

    return this.transformResponse(withScore);
  },

  /**
   * GET /framework-versions/:id/questions/lean/after/:order
   * Prefetch next N questions after a given order.
   * Now includes: score (alias of maxScore), example, guidanceMarkdown.
   * Usage: ?take=3 (defaults to 3; clamped 1..20)
   */
  async leanListNextByOrder(ctx) {
    const { id: versionDocumentId, order } = ctx.params;
    const baseOrder = Number(order);
    const take = Math.max(1, Math.min(20, Number((ctx.query as any)?.take ?? 3)));

    const fields = (ctx.query as any)?.fields ?? [
      'id',
      'order',
      'header',
      'subheader',
      'prompt',
      'example',
      'guidanceMarkdown',
      'maxScore',
    ];

    const entities = await strapi.documents('api::question.question').findMany({
      filters: {
        framework_version: { documentId: versionDocumentId },
        order: { $gt: baseOrder },
      },
      fields,
      sort: ['order:asc'],
      populate: [],
      pagination: { pageSize: take },
    });

    const sanitized = await this.sanitizeOutput(entities, ctx);
    const withScore = Array.isArray(sanitized)
      ? sanitized.map(({ maxScore, ...rest }) => ({ ...rest, score: maxScore }))
      : sanitized;

    return this.transformResponse(withScore);
  },
  /**
   * GET /framework-versions/:id/toc
   * Returns a lean "table of contents" for a framework version.
   * Includes only the header and order fields.
   * Sorted by order:desc.
   * Usage: call when rendering a TOC sidebar or index.
   */

  async listToc(ctx) {
  const { id: versionDocumentId } = ctx.params;

  const entities = await strapi
    .documents('api::question.question')
    .findMany({
      filters: { framework_version: { documentId: versionDocumentId } },
      fields: ['header', 'order'],     // TOC needs only these
      sort: ['order:asc'],            // DESC as requested
      populate: [],
      pagination: { pageSize: 500 },   // or adjust to your max
    });

  const sanitized = await this.sanitizeOutput(entities, ctx);
  return this.transformResponse(sanitized);
  },
}));
