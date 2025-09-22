// path: src/api/project/controllers/project.ts
import { factories } from '@strapi/strapi';
import { errors } from '@strapi/utils';

// helper to normalize role
const roleOf = (user: any): 'admin' | 'auditor' | 'authenticated' => {
  const n = String(user?.role?.name ?? '').toLowerCase();
  if (n === 'admin' || n === 'administrator') return 'admin';
  if (n === 'auditor') return 'auditor';
  return 'authenticated';
};

export default factories.createCoreController('api::project.project', ({ strapi }) => ({
  /**
   * POST /projects/create
   * Create a Project and its initial secret key (hash-only).
   * Body:
   * - domain: string (required)
   * - slug?: string
   * - valueHash: string (required, sha256 hex of the secret) — server never sees plaintext
   */
  // src/api/project/controllers/project.ts
  async create(ctx) {
  const user = ctx.state.user;
  if (!user) return ctx.unauthorized('Login required');

  const body = (ctx.request.body || {}) as any;
  const { domain, slug, valueHash } = body;

  if (!domain) return ctx.badRequest('Missing "domain".');
  if (!valueHash || typeof valueHash !== 'string') {
    return ctx.badRequest('Missing "valueHash" (sha256 hex).');
  }

  // Only slug + domain at creation
  const data = await this.sanitizeInput({ domain, slug }, ctx);

  const entity = await strapi.service('api::project.project').createWithInitialKey({
    data,
    ownerUserId: user.id,
    valueHash,
  });

  const sanitized = await this.sanitizeOutput(entity, ctx);
  return this.transformResponse(sanitized);
},

  /**
   * POST /projects/join
   * Join a project ONLY if caller proves knowledge of the active project key
   * by providing its SHA-256 hex hash (valueHash).
   *
   * Preconditions:
   *  - valueHash must exactly match an ACTIVE, non-expired secret-key for the project.
   *  - If the user is already a member, return the project unchanged (idempotent).
   */
  async join(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Login required');

    const { projectId, valueHash } = (ctx.request.body || {}) as any;
    if (!projectId || !valueHash) {
      return ctx.badRequest('Required: { "projectId": "<docId>", "valueHash": "<sha256 hex>" }');
    }
    if (!/^[0-9a-f]{64}$/i.test(String(valueHash))) {
      return ctx.badRequest('valueHash must be a 64-char sha256 hex string');
    }

    try {
      const entity = await strapi
        .service('api::project.project')
        .joinByKeyHash({ projectId, valueHash, userId: user.id });

      const sanitized = await this.sanitizeOutput(entity, ctx);
      return this.transformResponse(sanitized);
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') return ctx.notFound(e.message);
      if (e?.code === 'FORBIDDEN') return ctx.forbidden(e.message);
      strapi.log.error('[projects.join] unexpected error', e);
      return ctx.internalServerError('Join failed');
    }
  },

  /**
   * GET /me/projects
   * List Projects where the caller is a member.
   * Accepts Strapi-standard query pieces (pagination/sort/filters) which the service may honor.
   */
  async getMeProjects(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Login required');

    const q = (ctx.query || {}) as Record<string, unknown>;
    const result = await strapi.service('api::project.project').listForUser({
      userId: user.id,
      // Pass through common options; service decides what to honor safely
      sort: q.sort,
      pagination: q.pagination,
      filters: q.filters,
      fields: q.fields,
      populate: q.populate,
    });

    const sanitized = await this.sanitizeOutput(result, ctx);
    return this.transformResponse(sanitized);
  },

  async find(ctx) {
      const user = ctx.state?.user;
      if (!user) throw new errors.UnauthorizedError('Login required');

      if (!roleOf(user)) {
        // short, explicit error; swap for ctx.forbidden(...) if you prefer
        throw new errors.ForbiddenError('Only admins or auditors may list all projects');
      }

      // delegate to core logic (respects filters/pagination in ctx.query)
      return await super.find(ctx);
    },
  /**
   * GET /projects/:id
   * Fetch a single Project (documentId) for dashboards, without exposing secret keys.
   */
  async findOne(ctx) {
    const { id: documentId } = ctx.params;

    const entity = await strapi.service('api::project.project').findOne(documentId, {
      fields: ['slug', 'domain', 'createdAt', 'updatedAt'],
      populate: {
        users_permissions_users: {
          // plugin::users-permissions.user fields (no password ever returned)
          fields: ['id', 'username', 'email', 'confirmed', 'blocked'],
          populate: [], // keep it shallow
        },
      },
    });

   if (!entity) return ctx.notFound('Project not found');

   const sanitized = await this.sanitizeOutput(entity, ctx);
   return this.transformResponse(sanitized);
  },
  /**
   * GET /projects/slug/:slug
   * Fetch a single Project by slug.
   * Optional query: publicationState=preview to allow draft reads.
   */
  async getBySlug(ctx) {
    const { slug } = ctx.params;
    if (!slug) return ctx.badRequest('Missing "slug"');

    const q = (ctx.query || {}) as any;
    const publicationState = q.publicationState === 'preview' ? 'preview' : 'live';

    const entity = await strapi.service('api::project.project').getBySlug({
      slug,
      publicationState,
    });

    if (!entity) return ctx.notFound('Project not found');

    const sanitized = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitized);
  },

  /**
 * GET /projects/:projectId/filings
 * Returns an array of Filing documentIds for the given Project.
 * Optional query: ?publicationState=preview to include drafts.
 */
  async listFilingIds(ctx) {
    const { projectId } = ctx.params;
    const publicationState =
      (ctx.query?.publicationState === 'preview' ? 'preview' : 'live') as 'live' | 'preview';

    try {
      const ids = await strapi.service('api::project.project').listFilingIdsForProject({
        projectId,
        publicationState,
      });

        // Keep response minimal: just an array of strings
        return this.transformResponse(ids);
      } catch (e: any) {
        if (typeof e.message === 'string' && e.message.startsWith('NOT_FOUND')) {
          return ctx.notFound('Project not found');
        }
        throw e;
      }
    },


  async removeMember(ctx) {
    const { projectId, userId } = ctx.params;
    const actor = ctx.state.user;
    const actorRole = roleOf(actor);
    const targetUserId = Number(userId);

    const result = await strapi.service('api::project.project').removeMembers({
      projectDocumentId: String(projectId),
      targetUserIds: [Number(userId)],
      actorUserId: Number(actor.id),
      actorRole,
      reason: 'admin-remove',
    });

    ctx.body = { ok: true, removed: result.removedUserIds, project: result.project };
  }
}));
