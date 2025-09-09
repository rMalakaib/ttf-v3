// path: src/policies/enforce-project-membership.ts
// Reusable policy: only allow writes/reads if user is a member of the related Project.
// Admin + Auditor may write to all projects. Works with Documents API shapes.

type ActorRole = 'Authenticated' | 'auditor' | 'admin';

const deriveActorRole = (user: any): ActorRole => {
  const raw = (user?.role?.name ?? '').toString().trim().toLowerCase();
  if (raw === 'admin' || raw === 'administrator') return 'admin';
  if (raw === 'auditor') return 'auditor';
  return 'Authenticated';
};

// Extract a documentId (or id) from various relation shapes (raw, {id}, {documentId}, {connect:[...]})
const pickDocId = (rel: any): string | null => {
  if (!rel) return null;
  if (typeof rel === 'string') return rel;
  if (typeof rel === 'number') return String(rel);
  if (typeof rel === 'object') {
    if (rel.documentId) return String(rel.documentId);
    if (rel.id)         return String(rel.id);
    const c = Array.isArray(rel.connect) ? rel.connect[0] : null;
    if (c) {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (c.documentId) return String(c.documentId);
      if (c.id)         return String(c.id);
    }
  }
  return null;
};

// logging toggle (route config OR env)
const shouldLog = (config: any): boolean => {
  if (config && config.logging === false) return false;
  const v = String(process.env.POLICY_LOGGING ?? '1').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
};

// best-effort writer (never throws)
async function writeActivity(
  strapi: any,
  enabled: boolean,
  {
    allow, reason, entityType, entityId, userId, meta,
  }: {
    allow: boolean;
    reason: string;
    entityType: string;
    entityId: string;
    userId?: number | string | null;
    meta?: Record<string, any>;
  }
) {
  if (!enabled) return;
  try {
    await strapi.documents('api::activity-log.activity-log').create({
      data: {
        action: allow ? 'edit' : 'lock',
        entityType,
        entityId: String(entityId),
        beforeJson: { reason, ...(meta || {}) },
        afterJson: null,
        ...(userId ? { users_permissions_user: { id: userId } } : {}),
      },
      status: 'published',
    } as any);
  } catch {}
}

export default async (policyContext: any, config: any, { strapi }: { strapi: any }) => {
  const method = String(policyContext.request?.method ?? policyContext.request?.ctx?.method ?? '').toUpperCase();
  const path   = String(policyContext.request?.url ?? policyContext.request?.ctx?.url ?? '');
  const logOn  = shouldLog(config);

  // Only guard writes
  const isWrite = ['POST','PUT','PATCH','DELETE'].includes(method);
  const isRead  = ['GET','HEAD'].includes(method);
  // Let OPTIONS etc. pass through
  if (!isWrite && !isRead) return true;


  const user   = policyContext.state?.user;
  const userId = user?.id ?? null;
  const role   = deriveActorRole(user);

  const entityType = 'project-membership.policy';
  let   entityIdForLog = 'unknown';

  if (!userId) {
    await writeActivity(strapi, logOn, {
      allow:false, reason:'unauthenticated', entityType, entityId:'unknown',
    });
    return { status:401, message:'Authentication required' };
  }

  // Admin/auditor → allowed everywhere
  if (role === 'admin' || role === 'auditor') {
    await writeActivity(strapi, logOn, {
      allow:true,
      reason:'privileged role',
      entityType,
      entityId:'any',
      userId,
      meta:{ method, path, role },
    });
    return true;
  }

  // Determine target model (affects how we resolve Project)
  const target = (config?.target ?? 'answer-revision').toString();

  let projectDocumentId: string | null = null;

  try {
    if (target === 'filing') {
      if (method === 'POST') {
        const body = policyContext.request?.body ?? {};
        const data = 'data' in (body || {}) ? (body as any).data : body;
        const projDocId = pickDocId(data?.project);
        if (!projDocId) {
          await writeActivity(strapi, logOn, {
            allow:false,
            reason:'filing.create missing project relation',
            entityType, entityId:'new', userId,
            meta:{ method, path, role, dataKeys:Object.keys(data || {}) },
          });
          return { status:400, message:'Filing.create requires project' };
        }
        projectDocumentId = projDocId;
        entityIdForLog = 'new';
      } else {
        const filingDocId = policyContext.params?.id ?? null;
        if (!filingDocId) {
          await writeActivity(strapi, logOn, {
            allow:false, reason:'filing read/write missing id param', entityType, entityId:'unknown', userId,
            meta:{ method, path, role },
          });
          return { status:400, message:'Missing filing documentId' };
        }
        entityIdForLog = filingDocId;
        const filing = await strapi.documents('api::filing.filing').findOne({
          documentId: filingDocId,
          fields: ['documentId'] as any,
          populate: { project: { fields: ['documentId'] as any } } as any,
        } as any);
        projectDocumentId = filing?.project?.documentId ?? null;
      }
    } else {
      // AnswerRevision
      if (method === 'POST') {
        const body = policyContext.request?.body ?? {};
        const data = 'data' in (body || {}) ? (body as any).data : body;

        // Prefer a filing relation in body (Documents API shape)
        const filingRelDocId = pickDocId(data?.filing);

        // Custom route support: /filings/:filingId/questions/:questionId/draft
        const filingDocIdFromParams = policyContext.params?.filingId ?? null;

        const filingDocId = filingRelDocId ?? filingDocIdFromParams;
        if (!filingDocId) {
          await writeActivity(strapi, logOn, {
            allow:false,
            reason:'rev.create missing filing relation/param',
            entityType, entityId:'new', userId,
            meta:{ method, path, role, params:policyContext.params, bodyKeys:Object.keys(data || {}) },
          });
          return { status:400, message:'AnswerRevision.create requires filing relation or filingId param' };
        }

        const filing = await strapi.documents('api::filing.filing').findOne({
          documentId: filingDocId,
          fields: ['documentId'] as any,
          populate: { project: { fields: ['documentId'] as any } } as any,
        } as any);

        projectDocumentId = filing?.project?.documentId ?? null;
        entityIdForLog = 'new';
      } else {
        // Update/Delete: either standard CRUD (/answer-revisions/:id) or custom route with filingId
        const revDocId  = policyContext.params?.id ?? null;
        const filingPid = policyContext.params?.filingId ?? null;

        if (filingPid) {
          // Custom draft route: resolve via filing directly
          const filing = await strapi.documents('api::filing.filing').findOne({
            documentId: filingPid,
            fields: ['documentId'] as any,
            populate: { project: { fields: ['documentId'] as any } } as any,
          } as any);
          projectDocumentId = filing?.project?.documentId ?? null;
          entityIdForLog = filingPid;
        } else if (revDocId) {
          const rev = await strapi.documents('api::answer-revision.answer-revision').findOne({
            documentId: revDocId,
            fields: ['documentId'] as any,
            populate: { filing: { fields: ['documentId'] as any, populate: { project: { fields: ['documentId'] as any } } } } as any,
          } as any);
          projectDocumentId = rev?.filing?.project?.documentId ?? null;
          entityIdForLog = revDocId;
        } else {
          await writeActivity(strapi, logOn, {
            allow:false, reason:'rev read/write missing id/filingId params', entityType, entityId:'unknown', userId,
            meta:{ method, path, role, params:policyContext.params },
          });
          return { status:400, message:'Missing answer-revision documentId or filingId param' };
        }
      }
    }
  } catch (e) {
    await writeActivity(strapi, logOn, {
      allow:false, reason:'entity lookup failed', entityType, entityId:entityIdForLog, userId,
      meta:{ method, path, role, error:String((e as any)?.message ?? e) },
    });
    return { status:500, message:'Project membership check failed (lookup error)' };
  }

  if (!projectDocumentId) {
    await writeActivity(strapi, logOn, {
      allow:false, reason:'no project associated', entityType, entityId:entityIdForLog, userId,
      meta:{ method, path, role, target },
    });
    return { status:403, message:'Project membership: no project associated' };
  }

  // Check membership
  try {
    const membership = await strapi.documents('api::project.project').findMany({
      filters: { documentId: projectDocumentId, users_permissions_users: { id: userId } },
      fields: ['documentId'] as any,
      pagination: { pageSize: 1 },
    } as any);

    const isMember = Array.isArray(membership) && membership.length > 0;

    if (!isMember) {
      await writeActivity(strapi, logOn, {
        allow:false,
        reason:'not a project member',
        entityType,
        entityId:entityIdForLog,
        userId,
        meta:{ method, path, role, target, projectDocumentId },
      });
      return { status:403, message:'Only project members may modify this resource' };
    }

    await writeActivity(strapi, logOn, {
      allow:true,
      reason:'member ok',
      entityType,
      entityId:entityIdForLog,
      userId,
      meta:{ method, path, role, target, projectDocumentId },
    });
    return true;
  } catch (e) {
    await writeActivity(strapi, logOn, {
      allow:false,
      reason:'membership check failed',
      entityType,
      entityId:entityIdForLog,
      userId,
      meta:{ method, path, role, error:String((e as any)?.message ?? e) },
    });
    return { status:500, message:'Project membership check failed' };
  }
};
