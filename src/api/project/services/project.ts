// path: src/api/project/services/project.ts
import { factories } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import crypto from 'node:crypto';

class NotFoundError extends Error { code = 'NOT_FOUND' as const; }
class ForbiddenError extends Error { code = 'FORBIDDEN' as const; }

const JOIN_SIGNING_SECRET = process.env.PROJECT_JOIN_SIGNING_SECRET || '';

// Minimal, dependency-free slug fallback (lowercase, a–z0–9, dashes)
function toSlug(input: string): string {
  return String(input)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}

export default factories.createCoreService('api::project.project', ({ strapi }) => ({

  /**
   * Create a Project and its initial active secret key.
   * Requires: domain, slug (if omitted, derived from domain)
   * Attaches the creator as a member and rotates in the initial key via Secret Key service.
   */
  async createWithInitialKey({
        data,
        ownerUserId,
        valueHash,
        }: {
        data: { slug?: string; domain: string };
        ownerUserId: number;
        valueHash: string;
        }) {
        if (!data?.domain) throw new Error('Missing domain');
        if (!valueHash) throw new Error('Missing valueHash');

        const slug = data.slug?.trim() ? data.slug.trim() : toSlug(data.domain);

        const createData: any = {
            slug,
            domain: data.domain,
            users_permissions_users: { connect: [{ id: Number(ownerUserId) }] },
        };
    

        // ✅ Create as PUBLISHED in one step (no draft first)
        const created = await strapi
            .documents('api::project.project')
            .create({ data: createData, status: 'published' });

        // Extra guard: ensure publish actually happened
        if (!(created as any).publishedAt) {
            throw new Error('Failed to publish project');
        }

        const projectId = created.documentId as string;

                // --- ADD THIS: emit 'projects:new-project-created' ---

        const payload = {
            documentId: created.documentId,            // or created.documentId if you prefer
            slug: created.slug,
            domain: created.domain,
            createdByUserId: ownerUserId ?? null,
            at: new Date().toISOString(),
            };

            // Get all admin/auditor ids
        const adminAuditorIds = await strapi
            .service('api::realtime-sse.targets')
            .listUserIdsByRoleNames(['admin', 'auditor', 'administrator']);

            // Fan-out to each admin/auditor
            for (const uid of adminAuditorIds) {
            await strapi.service('api::realtime-sse.pubsub').publish(
                `user:${uid}`,
                `user:new-project-created:state${uid}`,
                'user:new-project-created:state',
                payload
            );

        }
            // -------------------------------------------------------------------


        // Issue initial active key; if this fails
        try {
            await strapi.service('api::secret-key.secret-key').rotateForProject(projectId, valueHash);
        } catch (err) {
             strapi.log.warn(
                `[project:${projectId}] initial secret-key rotation failed: ${err?.message || err}`
            );
        }

        // Return the published entity
        return strapi.service('api::project.project').findOne(projectId, {
            fields: ['slug', 'domain', 'createdAt', 'updatedAt'],
            populate: { },
        });
},

  /**
   * Join a project ONLY if caller proves knowledge of the active project key
   * by providing its SHA-256 hex hash (valueHash).
   *
   * Preconditions:
   *  - valueHash must exactly match an ACTIVE, non-expired secret-key for the project.
   *  - If the user is already a member, return the project unchanged (idempotent).
   */
   async joinByKeyHash({
        projectId,
        valueHash,
        userId,
        }: {
        projectId: string;   // project documentId
        valueHash: string;   // sha256 hex of the shared secret (server NEVER sees plaintext)
        userId: number;
        }) {
        if (!projectId || typeof projectId !== 'string') {
            throw new NotFoundError('Project not found');
        }
        if (!valueHash || typeof valueHash !== 'string' || !/^[0-9a-f]{64}$/i.test(valueHash)) {
            throw new ForbiddenError('Missing or invalid key hash');
        }

            // 1) Revoke any expired keys first (keeps "active" set clean)
        await strapi.service('api::secret-key.secret-key').revokeExpiredForProject(projectId);

        // 2) Verify there exists an ACTIVE key with this exact hash
        const matches = await strapi.documents('api::secret-key.secret-key').findMany({
            filters: {
            project: { documentId: projectId },
            keyState: 'active',
            valueHash, // exact match required
            },
            fields: ['id'],
            populate: [],
        });
        if (!Array.isArray(matches) || matches.length === 0) {
            throw new ForbiddenError('Invalid or expired project key');
        }

        // 3) Load project with members to check idempotency
        const project = await strapi.service('api::project.project').findOne(projectId, {
            fields: ['slug', 'domain', 'createdAt', 'updatedAt'],
            populate: {
            users_permissions_users: { fields: ['id'] },
            },
        });
        if (!project) throw new NotFoundError('Project not found');

        const currentMembers: number[] = Array.isArray((project as any).users_permissions_users)
            ? (project as any).users_permissions_users.map((u: any) => Number(u.id))
            : [];

        if (currentMembers.includes(Number(userId))) {
            // already a member → return as-is (published state unchanged)
            return project;
        }

        // 4) Append caller; use `set` to write a deduped list
        const nextMembers = Array.from(new Set([...currentMembers, Number(userId)])).map(id => ({ id }));
        await strapi.documents('api::project.project').update({
            documentId: projectId,
            data: { users_permissions_users: { set: nextMembers } },
        });

        // 5) Publish so the change is live (avoid "Modified" state)
        await strapi.documents('api::project.project').publish({ documentId: projectId });

        // 6) Return the published document (include members for the dashboard)
        const updated = await strapi.service('api::project.project').findOne(projectId, {
            fields: ['slug', 'domain', 'createdAt', 'updatedAt'],
            populate: {
            users_permissions_users: {
                fields: ['id', 'username', 'email', 'confirmed', 'blocked'],
                sort: ['id:asc'],
            },
            },
        });

     return updated;
},

  /**
   * List projects where this user is a member.
   */
  async listForUser({
    userId,
    sort,
    pagination,
    filters,
    fields,
    populate,
  }: {
    userId: number;
    sort?: any;
    pagination?: any;
    filters?: any;
    fields?: any;
    populate?: any;
  }) {
    const baseFilters = {
      ...(filters || {}),
      users_permissions_users: { id: Number(userId) },
    };

    const rows = await strapi.documents('api::project.project').findMany({
      filters: baseFilters,
      sort: (sort as any) ?? ['createdAt:desc'],
      ...(pagination ? { pagination } : {}),
      fields: (fields as any) ?? ['slug', 'domain', 'createdAt', 'updatedAt'],
      populate: (populate as any) ?? { },
    });

    return rows;
  },
  /**
   * Get a single Project by its slug (UID).
   * Defaults to live content; pass publicationState:'preview' if you need drafts.
   */
  async getBySlug({
        slug,
        publicationState = 'live',
        fields,
        populate,
        }: {
        slug: string;
        publicationState?: 'live' | 'preview';
        fields?: any;
        populate?: any;
        }) {
        const s = String(slug).trim();
        if (!s) throw new Error('Missing slug');

        const rows = await strapi.documents('api::project.project').findMany({
            publicationState,
            filters: { slug: s },
            sort: ['createdAt:desc'],
            pagination: { pageSize: 1 },
            fields: (fields as any) ?? ['slug', 'domain', 'createdAt', 'updatedAt'],
            populate:
            (populate as any) ??
            {
                users_permissions_users: { fields: ['id', 'username'] }, // add 'email','username' here if desired
            },
        });

        return rows?.[0] ?? null;
    },
    async listFilingIdsForProject({
        projectId,
        publicationState = 'live',
        }: {
        projectId: string;
        publicationState?: 'live' | 'preview';
        }): Promise<string[]> {
        // 404 if the project doesn't exist
        const exists = await strapi.documents('api::project.project').findOne({
            documentId: projectId,
            fields: ['id'],
            populate: [],
        });
        if (!exists) throw new Error('NOT_FOUND: Project not found');

        const rows = await strapi.documents('api::filing.filing').findMany({
            publicationState,
            filters: { project: { documentId: projectId } },
            sort: ['createdAt:desc'],
            pagination: { pageSize: 1000 }, // adjust if you expect more; or add pagination passthrough
            fields: ['id'], // minimal; documentId is always present on the returned items
            populate: [],
        });

        return (rows || []).map(r => String((r as any).documentId));
},
    async removeMembers({
        projectDocumentId,
        targetUserIds,
        actorUserId,
        actorRole,
        reason,
        }: {
        projectDocumentId: string;
        targetUserIds: number[];
        actorUserId: number;
        actorRole: 'admin' | 'auditor' | 'authenticated';
        reason?: 'admin-remove' | 'self-remove';
        }) {
        if (!projectDocumentId || !Array.isArray(targetUserIds) || targetUserIds.length === 0) {
            throw new errors.ApplicationError('Missing projectDocumentId or targetUserIds');
        }

        // Ensure project exists (minimal fetch)
        const project = await strapi.documents('api::project.project').findFirst({
            filters: { documentId: projectDocumentId },
            fields: ['slug'],
        });
        if (!project) throw new errors.NotFoundError('Project not found');

        // Role rules:
        // - admin/auditor: may remove any user(s)
        // - authenticated (regular): may only remove self, and only if allowSelf=true
        const isElevated = actorRole === 'admin' || actorRole === 'auditor';
        const isSelfOnly = targetUserIds.length === 1 && targetUserIds[0] === actorUserId;

        if (!isElevated && !isSelfOnly) {
        throw new errors.ForbiddenError('Only admin/auditor may remove other users');
        }

        // (Optional) verify each target is currently a member; skip if you want idempotency
        const memberCount = await strapi.documents('api::project.project').count({
            filters: {
            documentId: projectDocumentId,
            users_permissions_users: { id: { $in: targetUserIds } },
            },
        });

        // Activity log
        try {
            await strapi.documents('api::activity-log.activity-log').create({
            status: 'published',
            data: {
                action: 'edit',
                entityType: 'project.membership',
                entityId: String(projectDocumentId),
                beforeJson: {
                reason: reason ?? (isSelfOnly ? 'self-remove' : 'admin-remove'),
                actorUserId,
                actorRole,
                targetUserIds,
                },
                afterJson: {
                removedUserIds: targetUserIds,
                at: new Date().toISOString(),
                },
                // users_permissions_user: { connect: [actorUserId] }, // optional link to actor
            },
            });
        } catch (e) {
            strapi.log.warn('[project.removeMembers] failed to write activity log: %s', e?.message ?? e);
        }

        await strapi.documents('api::project.project').update({
            documentId: projectDocumentId,
            status: 'published',
            data: {
                users_permissions_users: {
                disconnect: targetUserIds,   // 👈 removes links
                },
            },
            });

        if (memberCount < 1) {
            // idempotent behavior: do nothing if none were members
            return { removedUserIds: [], project };
        };

    // --- SSE: kick removed users off all live streams ---
        try {
        const sseBus = strapi.service('api::realtime-sse.pubsub');
        for (const uid of targetUserIds) {
            sseBus.disconnectAllForUser(Number(uid));
        }
        } catch (e: any) {
        strapi.log?.warn?.('[project.removeMembers] SSE disconnectAllForUser failed: %s', e?.message ?? e);
        }


    return { removedUserIds: targetUserIds };
    },

}));
