// QuestionLock service — strict TTL locks on (filing, question).
// Provides acquire, heartbeat, release, status, and ensureLockHeld (for Draft saves).

import { factories } from '@strapi/strapi';

type Id = string;
type RelId = string | number;

const now = () => new Date();
const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

export default factories.createCoreService('api::question-lock.question-lock', ({ strapi }) => ({
  // Acquire or renew a lock if free/expired or already held by this user.
  async acquire({
    filingDocumentId,
    questionDocumentId,
    userId,
    ttlSeconds,
  }: {
    filingDocumentId: Id;
    questionDocumentId: Id;
    userId: number;
    ttlSeconds: number;
  }) {
    const { filing, question } = await this.assertCoherence(filingDocumentId, questionDocumentId);

    const existing = await this.findLock(filingDocumentId, questionDocumentId);
    const nowTs = now();

    if (!existing || this.isExpired(existing.lockExpiresAt, nowTs)) {
      // Create OR take over expired lock
      const created = existing
        ? await strapi.documents('api::question-lock.question-lock').update({
            documentId: (existing as any).documentId,
            data: {
              lockExpiresAt: addSeconds(nowTs, ttlSeconds).toISOString(),
              filing: { id: (filing as any).id as RelId },
              question: { id: (question as any).id as RelId },
              users_permissions_user: { id: userId },
            },
            status: 'published',
          } as any)
        : await strapi.documents('api::question-lock.question-lock').create({
            data: {
              lockExpiresAt: addSeconds(nowTs, ttlSeconds).toISOString(),
              filing: { id: (filing as any).id as RelId },
              question: { id: (question as any).id as RelId },
              users_permissions_user: { id: userId },
            },
            status: 'published',
          } as any);


          // --- [SSE EMIT] lock acquired/takeover (fire-and-forget) ---

          // Minimal username lookup (no controller changes, no populate changes)
        let holderUsername: string | null = null;
        try {
          const u = await strapi.entityService.findOne(
            'plugin::users-permissions.user',
            userId,
            { fields: ['id', 'username'] }
          );
          holderUsername = u?.username ?? null;
        } catch (e) {
          strapi.log?.warn?.(`[question-lock.acquire] username lookup failed: ${e?.message ?? e}`);
        }
      try {
        // If you have it handy, resolve the current draft AnswerRevision id; otherwise omit.
        // const answerRevisionDocumentId = await this.findCurrentDraftRevisionId(filingDocumentId, questionDocumentId);
        
        const topic = `question:${filingDocumentId}:${questionDocumentId}`; // or `question:${filingDocumentId}:${questionDocumentId}:${answerRevisionDocumentId}`
        const ttlSec = Math.max(
          1,
          Math.floor((new Date((created as any).lockExpiresAt).getTime() - nowTs.getTime()) / 1000)
        );

        await strapi.service('api::realtime-sse.pubsub').publish(
          topic,
          `question:lock:${filingDocumentId}:${questionDocumentId}:${Date.now()}`, // id
          'question:lock',                                                        // event
          {
            holderUserId: userId,
            holderUsername,
            state: 'acquire',   // 'acquire' | 'refresh' | 'release'
            ttlSec,
            at: new Date().toISOString(),
          }
        );
      } catch (e: any) {
        strapi.log?.warn?.(`[question-lock.acquire] publish failed: ${e?.message ?? e}`);
      }
      // --- [/SSE EMIT] ---
      await this.logActivity({
        action: 'lock',
        entityType: 'question-lock',
        entityId: (created as any).documentId,
        afterJson: {
          op: existing ? 'takeover_expired' : 'acquire_new',
          filingDocumentId,
          questionDocumentId,
          lockedBy: userId,
          lockExpiresAt: (created as any).lockExpiresAt,
        },
        userId,
      });

      return created;
    }

    // Lock exists and is not expired
    const holderId = (existing as any)?.users_permissions_user?.id ?? null;
    if (holderId && Number(holderId) !== Number(userId)) {
      const err: any = new Error('Lock held by another user');
      err.status = 409;
      err.details = {
        reason: 'LOCK_HELD',
        lockedBy: holderId,
        lockExpiresAt: (existing as any).lockExpiresAt,
      };
      throw err;
    }

    // Re-entrant: extend for the same user
    const renewed = await strapi.documents('api::question-lock.question-lock').update({
      documentId: (existing as any).documentId,
      data: { lockExpiresAt: addSeconds(nowTs, ttlSeconds).toISOString() },
      status: 'published',
    } as any);

    await this.logActivity({
      action: 'lock',
      entityType: 'question-lock',
      entityId: (renewed as any).documentId,
      afterJson: {
        op: 'renew',
        filingDocumentId,
        questionDocumentId,
        lockedBy: userId,
        lockExpiresAt: (renewed as any).lockExpiresAt,
      },
      userId,
    });

    return renewed;
  },

  // Heartbeat extends only if the caller is the current holder and the lock is not expired.
  async heartbeat({
    filingDocumentId,
    questionDocumentId,
    userId,
    ttlSeconds,
  }: {
    filingDocumentId: Id;
    questionDocumentId: Id;
    userId: number;
    ttlSeconds: number;
  }) {
    const existing = await this.findLock(filingDocumentId, questionDocumentId);
    const nowTs = now();

    if (!existing || this.isExpired(existing.lockExpiresAt, nowTs)) {
      const err: any = new Error('No active lock');
      err.status = 409;
      err.details = { reason: 'LOCK_NOT_HELD_OR_EXPIRED' };
      throw err;
    }

    const holderId = (existing as any)?.users_permissions_user?.id ?? null;
    if (!holderId || Number(holderId) !== Number(userId)) {
      const err: any = new Error('Lock held by another user');
      err.status = 409;
      err.details = {
        reason: 'LOCK_HELD',
        lockedBy: holderId ?? null,
        lockExpiresAt: (existing as any).lockExpiresAt,
      };
      throw err;
    }

    const renewed = await strapi.documents('api::question-lock.question-lock').update({
      documentId: (existing as any).documentId,
      data: { lockExpiresAt: addSeconds(nowTs, ttlSeconds).toISOString() },
      status: 'published',
    } as any);

    // --- [SSE EMIT] lock heartbeat/refresh ---
    const expiresAtIso = (renewed as any).lockExpiresAt;
    const ttlSec = Math.max(
      1,
      Math.floor((new Date((renewed as any).lockExpiresAt).getTime() - nowTs.getTime()) / 1000)
    );

    let holderUsername: string | null = null;
    try {
      const u = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        userId,
        { fields: ['id', 'username'] }
      );
      holderUsername = u?.username ?? null;
    } catch (e: any) {
      strapi.log?.warn?.(`[question-lock.heartbeat] username lookup failed: ${e?.message ?? e}`);
    }

    try {
      const topic = `question:${filingDocumentId}:${questionDocumentId}`; // add :${answerRevisionId} if you include it
      await strapi.service('api::realtime-sse.pubsub').publish(
        topic,
        `question:lock:${filingDocumentId}:${questionDocumentId}:${Date.now()}`, // id
        'question:lock',                                                        // event
        {
          holderUserId: userId,
          holderUsername,               // ← new
          state: 'refresh',             // 'acquire' | 'refresh' | 'release'
          ttlSec,
          expiresAt: expiresAtIso,
          at: new Date().toISOString(),
        }
      );
    } catch (e: any) {
      strapi.log?.warn?.(`[question-lock.heartbeat] publish failed: ${e?.message ?? e}`);
    }
    // --- [/SSE EMIT] ---

    return renewed;
  },

  // Release the lock if the caller is the current holder (best-effort, idempotent).
  async release({
    filingDocumentId,
    questionDocumentId,
    userId,
  }: {
    filingDocumentId: Id;
    questionDocumentId: Id;
    userId: number;
  }) {
    const existing = await this.findLock(filingDocumentId, questionDocumentId);
    if (!existing) return;

    // If expired, delete it to keep table clean (optional)
    const expired = this.isExpired(existing.lockExpiresAt, now());
    const holderId = (existing as any)?.users_permissions_user?.id ?? null;

    if (expired || (holderId != null && Number(holderId) === Number(userId))) {
      await strapi.documents('api::question-lock.question-lock').delete({
        documentId: (existing as any).documentId,
      } as any);

      await this.logActivity({
        action: 'lock',
        entityType: 'question-lock',
        entityId: (existing as any).documentId,
        afterJson: {
          op: expired ? 'cleanup_expired' : 'release',
          filingDocumentId,
          questionDocumentId,
          lockedBy: holderId ?? null,
        },
        userId,
      });
    }
    // Non-holder active lock: ignore (204 from controller)
  },

  // Public-ish status (reads are open). Include holder display only for members/auditors/admin.
  async status({
    filingDocumentId,
    questionDocumentId,
    viewerId,
  }: {
    filingDocumentId: Id;
    questionDocumentId: Id;
    viewerId?: number | null;
  }) {
    const lock = await this.findLock(filingDocumentId, questionDocumentId);

    const res: any = { held: false };
    if (!lock) return res;

    const active = !this.isExpired(lock.lockExpiresAt, now());
    res.held = active;
    res.lockExpiresAt = (lock as any).lockExpiresAt;

    if (!active) return res;

    // Only surface holder identity to members or privileged roles
    const canSeeHolder = await this.canViewerSeeHolder(filingDocumentId, viewerId ?? null);
    if (canSeeHolder) {
      const u = (lock as any).users_permissions_user;
      if (u) res.lockedBy = { id: u.id, username: u.username, email: u.email ?? undefined };
    }
    return res;
  },

  // --- Guard callable from AnswerRevision.saveDraft (strict mode)
  // Throws 409 if no active lock held by user; refreshes TTL on success (optional).
  async ensureLockHeld({
    filingDocumentId,
    questionDocumentId,
    userId,
    ttlSecondsOnSuccess,
  }: {
    filingDocumentId: Id;
    questionDocumentId: Id;
    userId: number;
    ttlSecondsOnSuccess?: number; // e.g., refresh to keep alive on save
  }) {
    const lock = await this.findLock(filingDocumentId, questionDocumentId);
    if (!lock || this.isExpired(lock.lockExpiresAt, now())) {
      const err: any = new Error('Active lock required');
      err.status = 409;
      err.details = { reason: 'LOCK_NOT_HELD_OR_EXPIRED' };
      throw err;
    }
    const holderId = (lock as any)?.users_permissions_user?.id ?? null;
    if (!holderId || Number(holderId) !== Number(userId)) {
      const err: any = new Error('Active lock held by another user');
      err.status = 409;
      err.details = {
        reason: 'LOCK_HELD',
        lockedBy: holderId ?? null,
        lockExpiresAt: (lock as any).lockExpiresAt,
      };
      throw err;
    }

    // Refresh on success (acts like a server-side heartbeat during save)
    if (ttlSecondsOnSuccess && ttlSecondsOnSuccess > 0) {
      await strapi.documents('api::question-lock.question-lock').update({
        documentId: (lock as any).documentId,
        data: { lockExpiresAt: addSeconds(now(), ttlSecondsOnSuccess).toISOString() },
        status: 'published',
      } as any);
    }
  },

  // ------------------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ------------------------------------------------------------------------------------

  isExpired(lockExpiresAt: string | Date, ref: Date) {
    try {
      const t = typeof lockExpiresAt === 'string' ? new Date(lockExpiresAt) : lockExpiresAt;
      return t.getTime() <= ref.getTime();
    } catch {
      return true;
    }
  },

  // Ensure filing and question belong to the same FrameworkVersion.
  async assertCoherence(filingDocumentId: Id, questionDocumentId: Id) {
    const filing = await strapi.documents('api::filing.filing').findOne({
      documentId: filingDocumentId,
      fields: ['id'] as any,
      populate: { framework_version: { fields: ['id'] as any } } as any,
    } as any);
    const question = await strapi.documents('api::question.question').findOne({
      documentId: questionDocumentId,
      fields: ['id'] as any,
      populate: { framework_version: { fields: ['id'] as any } } as any,
    } as any);

    if (!filing || !question) {
      const which = !filing ? 'filing' : 'question';
      const err: any = new Error(`${which} not found`);
      err.status = 400;
      throw err;
    }

    const filingFvId = (filing as any)?.framework_version?.id;
    const questionFvId = (question as any)?.framework_version?.id;
    if (!filingFvId || !questionFvId || filingFvId !== questionFvId) {
      const err: any = new Error('Question does not belong to filing’s framework version');
      err.status = 400;
      throw err;
    }
    return { filing, question };
  },

  // Find current lock for (filing, question) with holder info
  async findLock(filingDocumentId: Id, questionDocumentId: Id) {
    const rows = await strapi.documents('api::question-lock.question-lock').findMany({
      publicationState: 'preview',
      filters: {
        filing: { documentId: filingDocumentId },
        question: { documentId: questionDocumentId },
      },
      fields: ['documentId', 'lockExpiresAt'] as any,
      populate: {
        users_permissions_user: { fields: ['id', 'username', 'email'] as any },
      } as any,
      pagination: { pageSize: 1 },
    } as any);
    return rows?.[0] ?? null;
  },

  // Decide if viewer can see holder identity (members, auditors, admins)
  async canViewerSeeHolder(filingDocumentId: Id, viewerId: number | null) {
    if (!viewerId) return false;

    // Check privileged roles first
    try {
      const user = await strapi.query('plugin::users-permissions.user').findOne({
        where: { id: viewerId },
        populate: ['role'],
        select: ['id'],
      } as any);
      const roleName = String(user?.role?.name ?? '').toLowerCase();
      if (roleName === 'admin' || roleName === 'administrator' || roleName === 'auditor') return true;
    } catch {
      // ignore and continue to membership check
    }

    // Membership check
    try {
      const filing = await strapi.documents('api::filing.filing').findOne({
        documentId: filingDocumentId,
        fields: ['documentId'] as any,
        populate: { project: { fields: ['documentId'] as any } } as any,
      } as any);

      const projectDocId = (filing as any)?.project?.documentId ?? null;
      if (!projectDocId) return false;

      const membership = await strapi.documents('api::project.project').findMany({
        filters: {
          documentId: projectDocId,
          users_permissions_users: { id: viewerId },
        },
        fields: ['documentId'] as any,
        pagination: { pageSize: 1 },
      } as any);
      return Array.isArray(membership) && membership.length > 0;
    } catch {
      return false;
    }
  },

  async logActivity({
    action,
    entityType,
    entityId,
    beforeJson,
    afterJson,
    userId,
  }: {
    action: 'edit' | 'score' | 'submit' | 'override' | 'lock';
    entityType: string;
    entityId: string;
    beforeJson?: any;
    afterJson?: any;
    userId?: number;
  }) {
    try {
      await strapi.documents('api::activity-log.activity-log').create({
        data: {
          action,
          entityType,
          entityId: String(entityId),
          beforeJson: beforeJson ?? null,
          afterJson: afterJson ?? null,
          ...(userId ? { users_permissions_user: { id: userId } } : {}),
        },
        status: 'published',
      } as any);
    } catch {
      // swallow logging failures
    }
  },
}));
