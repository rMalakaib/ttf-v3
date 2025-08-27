import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::framework-family.framework-family', () => ({
  /**
   * GET /api/framework-families
   * Query params:
   *  - q: string (case-insensitive search across name, code)
   *  - codes: CSV or repeated (?codes=A&codes=B) to filter specific codes
   * Uses minimal fields and no populate by default.
   */
  async find(ctx) {
    const { q, codes } = ctx.request.query as Record<string, unknown>;

    const filters: any = { ...(ctx.query as any)?.filters };
    const or: any[] = [];

    if (typeof q === 'string' && q.trim()) {
      or.push({ name: { $containsi: q } }, { code: { $containsi: q } });
    }

    if (codes) {
      const list = Array.isArray(codes)
        ? (codes as string[]).flatMap(s => s.split(','))
        : String(codes).split(',');
      const normalized = list.map(s => s.trim()).filter(Boolean);
      if (normalized.length) filters.code = { $in: normalized };
    }

    if (or.length) filters.$or = or;

    const sort = (ctx.query as any)?.sort ?? 'name:asc';
    const pagination = (ctx.query as any)?.pagination;

    const families = await strapi
    .service('api::framework-family.framework-family')
    .listWithVersionIds({ filters, sort, ...(pagination ? { pagination } : {}) });

    const sanitized = await this.sanitizeOutput(families, ctx);
    return this.transformResponse(sanitized);
  },

  /**
   * GET /api/framework-families/:id   ← here ':id' is a *documentId* in v5
   */
  async findOne(ctx) {
    const { id: documentId } = ctx.params;

    // Use the v5 Core Service wrapper (backs the Document Service) to fetch by documentId
    const entity = await strapi.service('api::framework-family.framework-family').findOne(documentId, {
      fields: ['code', 'name'],
      populate: [],
    });

    if (!entity) return ctx.notFound('FrameworkFamily not found');

    const sanitized = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitized);
  },
  
   /**
   * GET /api/framework-families/:id/versions/active
   * Lists all active versions for a family, newest version first.
   */
  async listActivatedForFamily(ctx) {
  const { id: familyDocumentId } = ctx.params; // this is the *documentId*

  const versions = await strapi
    .documents('api::framework-version.framework-version')
    .findMany({
      filters: { isActive: true, framework_family: { documentId: familyDocumentId } },
      sort: ['version:desc'] as const,
      fields: ['id', 'version', 'isActive'] as const, // <-- no 'documentId' here
      // pagination: { page: 1, pageSize: 1 }, // add this if you only want the newest one
    });

  // versions[i].documentId is still available on each item
  const sanitized = await this.sanitizeOutput(versions, ctx);
  return this.transformResponse(sanitized);
},
}));
