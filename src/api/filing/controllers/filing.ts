// path: src/api/filing/controllers/filing.ts
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

  /** POST /filings/:id/submit  (client → next auditor stage) */
  async submit(ctx) {
    const { id: filingDocumentId } = ctx.params;
    try {
      const updated = await strapi.service('api::filing.filing').transitionAtomic({
        filingDocumentId,
        actorRole: 'client',  // policies should ensure this route is client-only
        action: 'submit',
      });
      const sanitized = await this.sanitizeOutput(updated, ctx);
      return this.transformResponse(sanitized);
    } catch (err: any) {
      if (err?.code === 'CONFLICT') return ctx.conflict(err.message);
      if (err?.code === 'FORBIDDEN_ACTION') return ctx.forbidden(err.message);
      if (err?.code === 'NOT_FOUND') return ctx.notFound(err.message);
      return ctx.badRequest(err?.message ?? 'Submit failed');
    }
  },

  /** POST /filings/:id/advance (auditor → next client stage) */
  async advance(ctx) {
    const { id: filingDocumentId } = ctx.params;
    try {
      const updated = await strapi.service('api::filing.filing').transitionAtomic({
        filingDocumentId,
        actorRole: 'auditor', // policies should ensure this route is auditor-only
        action: 'advance',
      });
      const sanitized = await this.sanitizeOutput(updated, ctx);
      return this.transformResponse(sanitized);
    } catch (err: any) {
      if (err?.code === 'CONFLICT') return ctx.conflict(err.message);
      if (err?.code === 'FORBIDDEN_ACTION') return ctx.forbidden(err.message);
      if (err?.code === 'NOT_FOUND') return ctx.notFound(err.message);
      return ctx.badRequest(err?.message ?? 'Advance failed');
    }
  },

  /** POST /filings/:id/finalize (auditor → final) */
  async finalize(ctx) {
    const { id: filingDocumentId } = ctx.params;
    try {
      const updated = await strapi.service('api::filing.filing').transitionAtomic({
        filingDocumentId,
        actorRole: 'auditor', // policies should ensure this route is auditor-only
        action: 'finalize',
      });
      const sanitized = await this.sanitizeOutput(updated, ctx);
      return this.transformResponse(sanitized);
    } catch (err: any) {
      if (err?.code === 'CONFLICT') return ctx.conflict(err.message);
      if (err?.code === 'FORBIDDEN_ACTION') return ctx.forbidden(err.message);
      if (err?.code === 'NOT_FOUND') return ctx.notFound(err.message);
      return ctx.badRequest(err?.message ?? 'Finalize failed');
    }
  },
}));
