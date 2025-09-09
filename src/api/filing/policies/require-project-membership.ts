// path: src/api/filing/policies/require-project-membership.ts
import { errors } from '@strapi/utils';

type ActorRole = 'admin' | 'auditor' | 'authenticated';
const roleOf = (user: any): ActorRole => {
  const n = String(user?.role?.name ?? '').toLowerCase();
  if (n === 'admin' || n === 'administrator') return 'admin';
  if (n === 'auditor') return 'auditor';
  return 'authenticated';
};

// fire-and-forget ActivityLog (awaited so it lands before short-circuit)
const logPolicy = async (
  strapi: any,
  {
    url, method, userId, role, entityId, allow, reason, extra,
  }: {
    url: string; method: string; userId: number | string; role: string;
    entityId?: string | null; allow: boolean; reason: string; extra?: Record<string, any>;
  }
) => {
  try {
    await strapi.documents('api::activity-log.activity-log').create({
      status: 'published',
      data: {
        action: 'edit',
        entityType: 'policy:filing.require-project-membership',
        entityId: String(entityId ?? ''),
        beforeJson: { url, method, userId, role },
        afterJson: { allow, reason, ...(extra ?? {}) },
      },
    });
  } catch (e: any) {
    strapi.log?.warn?.('[policy:filing] activity-log failed: %s', e?.message ?? e);
  }
};

// --- helpers -------------------------------------------------------------

const extractProjectFromCreateBody = (body: any): string | null => {
  const data = body?.data ?? body ?? {};
  const rel = data.project;
  if (!rel) return null;

  // { project: { documentId } }
  if (rel.documentId) return String(rel.documentId);

  // { project: { connect: [{ documentId }] } }
  const c = rel.connect;
  if (Array.isArray(c) && c[0]?.documentId) return String(c[0].documentId);

  return null;
};

const extractProjectFromQuery = (q: any): string | string[] | null => {
  // supports: filters[project][documentId]=..., or $in: [...]
  const docId = q?.filters?.project?.documentId;
  if (!docId) return null;
  if (typeof docId === 'string') return docId;
  if (docId?.$in && Array.isArray(docId.$in) && docId.$in.length) {
    return docId.$in.map((v: any) => String(v));
  }
  return null;
};

const getFilingProjectDocId = async (strapi: any, filingDocumentId: string): Promise<string | null> => {
  if (!filingDocumentId) return null;
  const row = await strapi.documents('api::filing.filing').findOne({
    documentId: String(filingDocumentId),
    fields: ['documentId'] as any,
    populate: { project: { fields: ['documentId'] as any } } as any,
  } as any);
  return row?.project?.documentId ?? null;
};

const isMemberOfProject = async (strapi: any, userId: number, projectDocId: string): Promise<boolean> => {
  const count = await strapi.documents('api::project.project').count({
    filters: { documentId: String(projectDocId), users_permissions_users: { id: Number(userId) } },
  } as any);
  return count > 0;
};

// --- policy --------------------------------------------------------------

export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) throw new errors.UnauthorizedError('Login required');

  const role   = roleOf(user);
  const method = String(policyContext.request?.method ?? 'GET').toUpperCase();
  const url    = String(policyContext.request?.url ?? '');
  const p      = policyContext.params ?? {};
  const body   = policyContext.request?.body ?? {};
  const q      = policyContext.request?.query ?? {};

  // ---- bypass: admin/auditor
  if (role === 'admin' || role === 'auditor') {
    await logPolicy(strapi, { url, method, userId: user.id, role, allow: true, reason: 'bypass: elevated role' });
    return true;
  }

  // ---- identify route kind we must guard
  const isFilingCrudBase = url.startsWith('/api/filings');
  const isFilingIdRoute  = /^\/api\/filings\/[^/]+(?:\/|\?|$)/.test(url);
  const isCustomAction   =
    /\/api\/filings\/[^/]+\/(submit|advance|finalize|recompute-final-score)(?:\/|\?|$)/.test(url) ||
    /\/api\/filings\/[^/]+\/final\/questions\/[^/]+\/override-score(?:\/|\?|$)/.test(url);
  const isFindOne = method === 'GET' && isFilingIdRoute && !isCustomAction;
  const isFind    = method === 'GET' && isFilingCrudBase && !isFilingIdRoute;
  const isCreate  = method === 'POST' && isFilingCrudBase && !isCustomAction;
  const isUpdDel  = (method === 'PUT' || method === 'PATCH' || method === 'DELETE') && isFilingIdRoute;

  // Also allow the project-scoped listing route if you use it: /api/projects/:projectId/filings
  const isProjectList = method === 'GET' && /^\/api\/projects\/[^/]+\/filings(?:\/|\?|$)/.test(url);

  // ---- routes tied to a specific filing id → resolve its project and check membership
  if (isCustomAction || isFindOne || isUpdDel) {
    const filingId = String(p.id ?? '').trim();
    if (!filingId) {
      await logPolicy(strapi, { url, method, userId: user.id, role, allow: false, reason: 'missing filing id' });
      throw new errors.PolicyError('Missing filing id', { policy: 'require-project-membership' });
    }

    const projectDocId = await getFilingProjectDocId(strapi, filingId);
    if (!projectDocId) {
      await logPolicy(strapi, { url, method, userId: user.id, role, allow: false, reason: 'filing has no project', extra: { filingId } });
      throw new errors.ForbiddenError('Filing not associated with a project');
    }

    const allow = await isMemberOfProject(strapi, Number(user.id), projectDocId);
    await logPolicy(strapi, { url, method, userId: user.id, role, allow, reason: allow ? 'member' : 'not a member', extra: { projectDocId } });
    if (!allow) throw new errors.ForbiddenError('Must be a member of this project');
    return true;
  }

  // ---- create → must carry a project relation in body and user must be a member
  if (isCreate) {
    const projectDocId = extractProjectFromCreateBody(body);
    if (!projectDocId) {
      await logPolicy(strapi, { url, method, userId: user.id, role, allow: false, reason: 'missing project in body' });
      throw new errors.PolicyError('Create requires project.documentId', { policy: 'require-project-membership' });
    }
    const allow = await isMemberOfProject(strapi, Number(user.id), projectDocId);
    await logPolicy(strapi, { url, method, userId: user.id, role, allow, reason: allow ? 'member' : 'not a member', extra: { projectDocId } });
    if (!allow) throw new errors.ForbiddenError('Must be a member of this project');
    return true;
  }

  // ---- collection find → require a project and verify membership (or project-scoped route)
  if (isFind || isProjectList) {
    let projectIds: string[] = [];

    if (isProjectList && p.projectId) {
      projectIds = [String(p.projectId)];
    } else {
      const proj = extractProjectFromQuery(q);
      if (typeof proj === 'string') projectIds = [proj];
      else if (Array.isArray(proj)) projectIds = proj.map(String);
    }

    if (!projectIds.length) {
      await logPolicy(strapi, { url, method, userId: user.id, role, allow: false, reason: 'missing project filter' });
      throw new errors.PolicyError('Find requires filters[project][documentId]', { policy: 'require-project-membership' });
    }

    // require membership in ALL provided projects (conservative)
    for (const pid of projectIds) {
      const ok = await isMemberOfProject(strapi, Number(user.id), pid);
      if (!ok) {
        await logPolicy(strapi, { url, method, userId: user.id, role, allow: false, reason: 'not a member of one or more projects', extra: { projectIds } });
        throw new errors.ForbiddenError('Must be a member of the requested project(s)');
      }
    }

    await logPolicy(strapi, { url, method, userId: user.id, role, allow: true, reason: 'member', extra: { projectIds } });
    return true;
  }

  // default deny for any other filing route shapes
  await logPolicy(strapi, { url, method, userId: user.id, role, allow: false, reason: 'unrecognized/guarded filings route' });
  throw new errors.ForbiddenError('Access denied by filing membership policy');
};
