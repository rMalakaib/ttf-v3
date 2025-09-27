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
        projectRef,         // ← renamed from projectId for clarity (can be docId OR slug)
        valueHash,
        userId,
        }: {
        projectRef: string;
        valueHash: string;  // sha256 hex
        userId: number;
        }) {
        if (!projectRef || typeof projectRef !== 'string') {
            throw new NotFoundError('Project not found');
        }
        if (!valueHash || typeof valueHash !== 'string' || !/^[0-9a-f]{64}$/i.test(valueHash)) {
            throw new ForbiddenError('Missing or invalid key hash');
        }

        // 1) Resolve by documentId or slug
        let project = await strapi.documents('api::project.project').findFirst({
            filters: { documentId: projectRef },
            populate: { users_permissions_users: { fields: ['id'] } },
        });
        if (!project) {
            project = await strapi.documents('api::project.project').findFirst({
            filters: { slug: projectRef },
            populate: { users_permissions_users: { fields: ['id'] } },
            });
        }
        if (!project) throw new NotFoundError('Project not found');

        const docId = String(project.documentId);

        // 2) Revoke expired keys, then verify an ACTIVE key with this exact valueHash exists
        await strapi.service('api::secret-key.secret-key').revokeExpiredForProject(docId);

        const activeKeyCount = await strapi.documents('api::secret-key.secret-key').count({
            filters: { project: { documentId: docId }, keyState: 'active', valueHash },
        });
        if (activeKeyCount < 1) throw new ForbiddenError('Invalid or expired project key');

        // 3) Idempotent membership add
        const currentMembers: number[] = Array.isArray((project as any).users_permissions_users)
            ? (project as any).users_permissions_users.map((u: any) => Number(u.id))
            : [];

        if (!currentMembers.includes(Number(userId))) {
            const nextMembers = Array.from(new Set([...currentMembers, Number(userId)])).map(id => ({ id }));
            await strapi.documents('api::project.project').update({
            documentId: docId,
            data: { users_permissions_users: { set: nextMembers } },
            });
            await strapi.documents('api::project.project').publish({ documentId: docId });
        }

        // 4) Return fresh snapshot (omit 'fields' so documentId is present if you need it)
        const updated = await strapi.documents('api::project.project').findFirst({
            filters: { documentId: docId },
            fields: ['slug', 'domain', 'createdAt', 'updatedAt'], // real attributes only (TS-friendly)
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
        }): Promise<Array<{ documentId: string; status: string; title: string | null }>> {
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
            pagination: { pageSize: 1000 },
            fields: ['filingStatus', 'title'] as any, // documentId is implicit on Documents API
            populate: [],
        });

        return (rows || []).map((r: any) => ({
            documentId: String(r.documentId),
            status: String(r.filingStatus),
            title: r.title ?? null,
        }));},
        
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
            // 1) tell their user channel what happened (client can clean up UI)
            await sseBus.publish(
            [`user:${Number(uid)}`],                // topics
            'project:membership:removed',           // event name
            {
                projectDocumentId,                    // 👈 include the project docId
                removedUserId: Number(uid),
                actorUserId,
                actorRole,
                reason: reason ?? (isSelfOnly ? 'self-remove' : 'admin-remove'),
                at: new Date().toISOString(),
            }
            );

            // 2) then forcibly disconnect all their live SSE streams
            sseBus.disconnectAllForUser(Number(uid), projectDocumentId);
        }
        } catch (e: any) {
        strapi.log?.warn?.(
            '[project.removeMembers] SSE notify/disconnect failed: %s',
            e?.message ?? e
        );
        }


    return { removedUserIds: targetUserIds };
    },

}));
