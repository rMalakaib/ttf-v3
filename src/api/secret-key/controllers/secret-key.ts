import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::secret-key.secret-key', ({ strapi }) => ({

  /** GET /projects/:projectId/secret-keys — all keys (active + revoked) */
  async listAll(ctx) {
    const { projectId } = ctx.params;

    const project = await strapi.service('api::secret-key.secret-key').ensureProject(projectId);
    if (!project) return ctx.notFound('Project not found');

    const keys = await strapi.service('api::secret-key.secret-key').listAll(projectId);
    const sanitized = await this.sanitizeOutput(keys, ctx);
    return this.transformResponse(sanitized);
  },

  /** GET /projects/:projectId/secret-keys/active — only active keys */
  async listActive(ctx) {
    const { projectId } = ctx.params;

    const project = await strapi.service('api::secret-key.secret-key').ensureProject(projectId);
    if (!project) return ctx.notFound('Project not found');

    const active = await strapi.service('api::secret-key.secret-key').listActive(projectId);
    const sanitized = await this.sanitizeOutput(active, ctx);
    return this.transformResponse(sanitized);
  },

  /** POST /projects/:projectId/secret-keys/:id/revoke — revoke by id (idempotent) */
  async revokeKey(ctx) {
    const { projectId, id: keyId } = ctx.params;
    try {
      const payload = await strapi
        .service('api::secret-key.secret-key')
        .revokeForProject(projectId, keyId);

      const sanitized = await this.sanitizeOutput(payload, ctx);
      return this.transformResponse(sanitized);
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') return ctx.notFound(e.message);
      if (e?.code === 'FORBIDDEN') return ctx.forbidden(e.message);
      throw e;
    }
  },

  /**
   * POST /projects/:projectId/secret-keys/rotate
   * Body (optional): { valueHash: string } — client-supplied hash
   * If omitted, server generates a secret and returns it once.
   */
  async rotateKey(ctx) {
    const { projectId } = ctx.params;
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const valueHash =
      typeof body.valueHash === 'string' && body.valueHash.trim() ? body.valueHash.trim() : undefined;

    try {
      const payload = await strapi
        .service('api::secret-key.secret-key')
        .rotateForProject(projectId, valueHash);

      const sanitized = await this.sanitizeOutput(payload, ctx);
      return this.transformResponse(sanitized);
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') return ctx.notFound(e.message);
      throw e;
    }
  },

}));
