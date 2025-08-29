// src/api/filing/controllers/filing.ts
import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::filing.filing', ({ strapi }) => ({
  async listByProject(ctx) {
    const { projectId } = ctx.params;
    const q = ctx.query as any;

    const rows = await strapi.service('api::filing.filing').listByProject({
      projectDocumentId: projectId,
      filters: q?.filters ?? {},
      sort: q?.sort,
      fields: q?.fields,
      pagination: q?.pagination,
    });

    const sanitized = await this.sanitizeOutput(rows, ctx);
    return this.transformResponse(sanitized);
  },

  async bootstrap(ctx) {
    const { projectId, familyId } = ctx.params;
    const q = ctx.query as any;
    const body = (ctx.request?.body ?? {}) as any;

    const familyDocumentId = familyId || undefined;
    const familyCode = (q?.familyCode ?? body?.familyCode) || undefined;

    try {
      const { filing: rawFiling, firstQuestion } =
        await strapi.service('api::filing.filing').bootstrap({
          projectDocumentId: projectId,
          familyDocumentId,
          familyCode,
        });

      // Sanitize only the filing (matches this controller's model)
      const filing = rawFiling ? await this.sanitizeOutput(rawFiling, ctx) : null;

      // Return the first question as-is (already lean fields from the service)
      return this.transformResponse({ filing, firstQuestion });
    } catch (err: any) {
      return ctx.badRequest(typeof err?.message === 'string' ? err.message : 'Failed to create filing');
    }
  },
}));
