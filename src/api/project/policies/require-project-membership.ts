// src/api/project/policies/require-project-membership.ts
import { errors } from '@strapi/utils';

type ActorRole = 'admin' | 'auditor' | 'Authenticated';
const roleOf = (user: any): ActorRole => {
  const n = String(user?.role?.name ?? '').toLowerCase();
  if (n === 'admin' || n === 'administrator') return 'admin';
  if (n === 'auditor') return 'auditor';
  return 'Authenticated';
};

// fire-and-forget ActivityLog (but awaited so it lands before error short-circuits)
const logPolicy = async (strapi: any, {
  url, method, userId, role, entityId, slug, allow, reason, memberCount,
}: {
  url: string; method: string; userId: number|string; role: string;
  entityId?: string|null; slug?: string|null; allow: boolean; reason: string; memberCount?: number;
}) => {
  try {
    await strapi.documents('api::activity-log.activity-log').create({
      status: 'published',
      data: {
        action: 'edit',
        entityType: 'policy:project.require-project-membership',
        entityId: String(entityId ?? slug ?? ''),
        beforeJson: { url, method, userId, role, entityId, slug },
        afterJson:  { allow, reason, memberCount },
      },
    });
  } catch (e: any) {
    strapi.log.warn('[policy:project] activity-log failed: %s', e?.message ?? e);
  }
};

export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) throw new errors.UnauthorizedError('Login required');

  const role   = roleOf(user);
  const method = String(policyContext.request?.method ?? 'GET').toUpperCase();
  const url    = String(policyContext.request?.url ?? '');
  const p      = policyContext.params ?? {};
  const body   = policyContext.request?.body ?? {};

  // ----- bypass: admin/auditor
  if (role === 'admin' || role === 'auditor') {
    await logPolicy(strapi, { url, method, userId: user.id, role, allow: true, reason: 'bypass: elevated role' });
    return true;
  }

  // ----- open routes you explicitly want allowed
  if (
    (method === 'POST' && url.startsWith('/api/projects/create')) ||
    (method === 'POST' && url.startsWith('/api/projects/join'))   ||
    (method === 'GET'  && url.startsWith('/api/me/projects'))
  ) {
    await logPolicy(strapi, { url, method, userId: user.id, role, allow: true, reason: 'open route' });
    return true;
  }

  // ----- resolve project by documentId or slug
  // NOTE: Do NOT read slug from body — body.slug may be a *new* slug (e.g., rename)
  let documentId: string | null =
    (p.projectId ?? p.documentId ?? p.id ?? body?.documentId ?? null) &&
    String(p.projectId ?? p.documentId ?? p.id ?? body?.documentId);

  const slug: string | null = p.slug ?? null;

  // Fallback: extract projectId from URL for custom routes like /api/projects/:projectId/rename
  // This handles cases where policyContext.params is empty for PUT/PATCH on custom routes.
  if (!documentId && !slug) {
    const m = url.match(/\/api\/projects\/([^/]+)\/rename(?:\/)?$/);
    if (m && m[1]) documentId = m[1];
  }

  if (!documentId && !slug) {
    await logPolicy(strapi, { url, method, userId: user.id, role, allow: false, reason: 'missing project identifier' });
    throw new errors.PolicyError('Missing project identifier', { policy: 'require-project-membership' });
  }

  // ----- membership check via COUNT (fast; no populate)
  const filters = slug
    ? { slug, users_permissions_users: { id: Number(user.id) } }
    : { documentId: String(documentId), users_permissions_users: { id: Number(user.id) } };

  const memberCount = await strapi.documents('api::project.project').count({ filters });

  const allow = memberCount > 0;
  await logPolicy(strapi, {
    url, method, userId: user.id, role,
    entityId: documentId ? String(documentId) : null,
    slug: slug ? String(slug) : null,
    allow,
    reason: allow ? 'member' : 'not a member',
    memberCount,
  });

  if (!allow) throw new errors.ForbiddenError('Must be a member of this project');
  return true;
};
