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

const normalizeSlug = (slug?: string) =>
  typeof slug === 'string' ? slug.trim().toLowerCase() || undefined : undefined;

// letters, numbers, hyphens, 3–64 chars
const SLUG_RE = /^[a-z0-9-]{3,64}$/;

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

    // ⬇️ Normalize slug: trim + lowercase (empty → undefined)
    const normalizedSlug =
      typeof slug === 'string'
        ? slug.trim().toLowerCase() || undefined
        : undefined;

    // Only slug + domain at creation
    const data = await this.sanitizeInput({ domain, slug: normalizedSlug }, ctx);

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

    const body = ctx.request.body ?? {};
    const projectRef = String(body.projectRef ?? body.projectId ?? '').trim().toLowerCase(); // <- accept docId OR slug
    const valueHash  = String(body.valueHash ?? '').trim();

    if (!projectRef || !valueHash) {
      return ctx.badRequest('Required: { "projectRef" (or "projectId"), "valueHash" }');
    }
    if (!/^[0-9a-f]{64}$/i.test(valueHash)) {
      return ctx.badRequest('valueHash must be a 64-char sha256 hex string');
    }

    try {
      const entity = await strapi
        .service('api::project.project')
        .joinByKeyHash({ projectRef, valueHash, userId: Number(user.id) }); // <- pass "projectRef"

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

      if (roleOf(user) === "authenticated") {
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
  },

  /**
   * PATCH /projects/:projectId/rename
   * Body: { slug: string }
   *
   * Renames a Project by updating its slug.
   * Auth required; membership enforced by route policy.
   */
  async rename(ctx) {
    const user = ctx.state?.user;
    if (!user) throw new errors.UnauthorizedError('Login required');

    const { projectId } = ctx.params;
    if (!projectId) return ctx.badRequest('Missing "projectId"');

    const body = (ctx.request.body || {}) as any;
    const wantedSlug = normalizeSlug(body.slug);

    if (!wantedSlug) return ctx.badRequest('Missing "slug" in body');
    if (!SLUG_RE.test(wantedSlug)) {
      return ctx.badRequest('Invalid slug (use 3–64 chars: a–z, 0–9, hyphen)');
    }

    // Verify project exists
    const existing = await strapi
      .documents('api::project.project')
      .findOne({ documentId: String(projectId), populate: [] });
    if (!existing) return ctx.notFound('Project not found');

    // Idempotent: nothing to do
    if (existing.slug === wantedSlug) {
      const sanitized = await this.sanitizeOutput(existing, ctx);
      return this.transformResponse(sanitized);
    }

    // Uniqueness check (exclude current project)
    const conflict = await strapi.documents('api::project.project').findFirst({
      filters: { slug: wantedSlug, documentId: { $ne: String(projectId) } },
      fields: ['id', 'slug'],
      populate: [],
      publicationState: 'live',
    });
    if (conflict) return ctx.conflict('Slug already in use');

    // (Optional) role gating beyond membership policy, if you want:
    // const actorRole = roleOf(user);
    // if (actorRole === 'authenticated') { /* enforce owner-only, etc. */ }

    const updated = await strapi.documents('api::project.project').update({
      documentId: String(projectId),
      data: { slug: wantedSlug },
      status: 'published',
    });

    const sanitized = await this.sanitizeOutput(updated, ctx);
    return this.transformResponse(sanitized);
  },

   /**
   * DELETE /projects/:id
   * Deep-deletes a project:
   *   1) deletes all secret-keys for the project
   *   2) deletes all filings for the project (reusing filing.controller.delete for full cascade)
   *   3) deletes the project itself
   * Sends SSE events and prunes channels where sensible.
   */
  async delete(ctx) {
    const projectDocumentId = String(ctx.params?.id ?? '');
    if (!projectDocumentId) return ctx.badRequest('Missing project documentId');

    // ---- fetch the project (to 404 early & for SSE) ----
    const existing = await strapi.documents('api::project.project').findOne({
      documentId: projectDocumentId,
      // keep lean; we only need the id/slug if you want to broadcast
      fields: ['id', 'slug'],
    }) as any;

    if (!existing) return ctx.notFound('Project not found');

    // Small helper: generic paged delete by filters
    const deleteAll = async (uid: string, filters: any, pageSize = 100) => {
      let total = 0;
      for (;;) {
        const rows = await (strapi.documents as any)(uid).findMany({
          filters,
          page: 1,
          pageSize,
          // keep it lean
          fields: ['documentId', 'id'],
          populate: [],
        }) as any[];
        if (!rows?.length) break;

        for (const row of rows) {
          const docId = row?.documentId ?? row?.id;
          if (docId) {
            await (strapi.documents as any)(uid).delete({ documentId: String(docId) });
            total++;
          }
        }
      }
      return total;
    };

    // Helper: call filing.controller.delete for full cascade (so we reuse your existing logic)
    const deleteFilingDeep = async (filingDocumentId: string) => {
      try {
        // Build a minimal synthetic ctx for the filing controller
        const filingController = strapi.controller('api::filing.filing') as any;
        const childCtx = {
          // carry auth & state through so policies still apply
          state: ctx.state,
          params: { id: filingDocumentId },
          // provide the minimal API used by your filing controller
          badRequest: (m: string) => { throw new Error(`400 ${m}`); },
          notFound: (m: string) => { throw new Error(`404 ${m}`); },
          forbidden: (m: string) => { throw new Error(`403 ${m}`); },
          conflict: (m: string) => { throw new Error(`409 ${m}`); },
          // not used by delete, but keep shape consistent
          query: {},
          request: { body: {} },
          // these two are used by sanitize/transform on success paths in some controllers
          async sanitizeOutput(v: any) { return v; },
          transformResponse(v: any) { return v; },
          // logging passthrough (optional)
          
        };

        // Invoke your existing cascade delete
        await filingController.delete.call(filingController, childCtx);
      } catch (e) {
        // Log and continue (best-effort per-filing)
        strapi.log?.warn?.(`[project.delete] filing ${filingDocumentId} delete failed: ${e instanceof Error ? e.message : e}`);
      }
    };

    // ---- 1) Delete all secret-keys for this project (no cascade needed) ----
    try {
      await deleteAll('api::secret-key.secret-key', {
        project: { documentId: projectDocumentId },
      });
    } catch (e) {
      strapi.log?.warn?.(`[project.delete] secret-key purge failed (continuing): ${e instanceof Error ? e.message : e}`);
    }

    // ---- 2) Find all filings for this project and delete each via filing controller cascade ----
    try {
      const filings = await (strapi.documents as any)('api::filing.filing').findMany({
        filters: { project: { documentId: projectDocumentId } },
        page: 1,
        pageSize: 500, // bump if needed; the loop inside filing.delete also pages children
        fields: ['documentId'],
        populate: [],
      }) as Array<{ documentId: string }>;

      for (const f of (filings || [])) {
        if (f?.documentId) await deleteFilingDeep(f.documentId);
      }
    } catch (e) {
      strapi.log?.warn?.(
        `[project.delete] fetching/deleting filings failed (continuing): ${e instanceof Error ? e.message : e}`
      );
    }

    // ---- 3) Delete the project itself ----
    const deleted = await strapi.documents('api::project.project').delete({
      documentId: projectDocumentId,
    });
    if (!deleted) return ctx.notFound('Project not found (already removed)');

    // ---- 4) Publish SSE + prune project channels ----
    try {
      const pubsub: any = strapi.service('api::realtime-sse.pubsub');
      const payload = {
        projectId: projectDocumentId,
        slug: existing?.slug ?? null,
        at: new Date().toISOString(),
      };

      pubsub?.publish?.(`project:${projectDocumentId}`, 'project:deleted', payload);

      // If your pubsub has helpers; otherwise noop safety
      if (typeof pubsub.disconnectTopic === 'function') {
        pubsub.disconnectTopic(`project:${projectDocumentId}`);
      }
      if (typeof pubsub.disconnectTopicPrefix === 'function') {
        // optionally force-drop any project-scoped topics your frontend might subscribe to
        pubsub.disconnectTopicPrefix(`filing:`); // filings were already removed; safe if no-op
      }
    } catch (err) {
      strapi.log?.warn?.(
        `[project.delete] publish/disconnect failed: ${err instanceof Error ? err.message : err}`
      );
    }

    // mirror your other controllers: return the deleted entity payload
    return deleted;
  },


}));
