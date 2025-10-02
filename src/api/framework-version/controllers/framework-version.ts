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
      ? sanitized.map(({ maxScore, ...rest }) => ({ ...rest, maxScore: maxScore }))
      : sanitized;

    return this.transformResponse(withScore);
  },
  /**
   * GET /filings/:filingId/toc
   * Returns a lean TOC for the framework version related to a filing.
   * Fields: header, order; sorted by order:asc.
   */
  async listToc(ctx) {
    const { filingId } = ctx.params;

    // 1) Load the filing (by documentId) and populate the relation to get framework_version.documentId
    const filing = await strapi
      .documents('api::filing.filing')
      .findFirst({
        filters: { documentId: filingId },
        populate: {
          framework_version: { fields: ['id'] },
        },
        fields: ['id'], // only what we need
      });

    if (!filing) {
      ctx.throw(404, `Filing with documentId "${filingId}" not found`);
    }

    const frameworkVersionDocId = filing.framework_version?.documentId;
    if (!frameworkVersionDocId) {
      ctx.throw(400, `Filing "${filingId}" is not linked to a framework_version`);
    }

    // 2) Fetch questions for that framework version (TOC)
    const entities = await strapi
      .documents('api::question.question')
      .findMany({
        filters: { framework_version: { documentId: frameworkVersionDocId } },
        fields: ['header', 'order'],
        sort: ['order:asc'],
        populate: [],
        pagination: { pageSize: 500 },
      });

    const sanitized = await this.sanitizeOutput(entities, ctx);
    return this.transformResponse(sanitized);
  },

     async listFinalScores(ctx) {
    const frameworkVersionIdParam = String(ctx.params?.frameworkVersionId || '').trim();
    const filingIdParam = String(ctx.params?.filingId || '').trim();

    // Optional finalizedAt range: ?start=YYYY-MM-DD&end=YYYY-MM-DD (inclusive)
    const start = ctx.query?.start ? String(ctx.query.start) : null;
    const end   = ctx.query?.end   ? String(ctx.query.end)   : null;

    let frameworkVersionId = frameworkVersionIdParam;

    // If no frameworkVersionId was provided, try resolving from filingId
    if (!frameworkVersionId && filingIdParam) {
      const filing = (await strapi.documents('api::filing.filing').findOne({
      documentId: filingIdParam,
      publicationState: 'preview',
      fields: ['documentId'] as any,
      populate: {
        framework_version: { fields: ['documentId'] as any },
      } as any,
    } as any)) as unknown as {
      framework_version?: { documentId?: string };
    } | null;

    if (!filing) ctx.throw(404, 'filing not found');

    const frameworkVersionId =
      filing?.framework_version?.documentId ?? '';

    if (!frameworkVersionId) ctx.throw(422, 'filing has no framework_version');

    if (!frameworkVersionId) {
      ctx.throw(400, 'frameworkVersionId or filingId is required');
    }

    const results = await strapi
      .service('api::framework-version.framework-version')
      .listFinalScores({ frameworkVersionId, start, end });

    ctx.body = { data: results, meta: { count: results.length, frameworkVersionId } };
  }},

  async listFilingsWithScores(ctx) {
    const frameworkVersionId = String(ctx.params?.frameworkVersionId || '').trim();
    if (!frameworkVersionId) ctx.throw(400, 'frameworkVersionId is required');

    // Optional range on Submission.submittedAt: ?start=YYYY-MM-DD&end=YYYY-MM-DD (inclusive)
    const start = ctx.query?.start ? String(ctx.query.start) : null;
    const end   = ctx.query?.end   ? String(ctx.query.end)   : null;

    const rows = await strapi
      .service('api::framework-version.framework-version')
      .listFilingsWithScores({ frameworkVersionId, start, end });

    ctx.body = { data: rows, meta: { count: rows.length } };
  },
})); 
