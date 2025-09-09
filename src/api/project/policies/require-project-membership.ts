// src/api/project/policies/require-project-membership.ts
import { errors } from '@strapi/utils';

type ActorRole = 'admin' | 'auditor' | 'authenticated';
const roleOf = (user: any): ActorRole => {
  const n = String(user?.role?.name ?? '').toLowerCase();
  if (n === 'admin' || n === 'administrator') return 'admin';
  if (n === 'auditor') return 'auditor';
  return 'authenticated';
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
        action: 'edit',                 // using existing enum; “policy decision” audit
        entityType: 'policy:project.require-project-membership',
        entityId: String(entityId ?? slug ?? ''),
        beforeJson: { url, method, userId, role, entityId, slug },
        afterJson:  { allow, reason, memberCount },
        // If you want to relate the user, uncomment the connect line below (works in v5):
        // users_permissions_user: { connect: [Number(userId)] },
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

  // ----- resolve project by documentId or slug (works for :projectId, :id, or body)
  const documentId = p.projectId ?? p.documentId ?? p.id ?? body?.documentId ?? null;
  const slug       = p.slug ?? body?.slug ?? null;

  if (!documentId && !slug) {
    await logPolicy(strapi, { url, method, userId: user.id, role, allow: false, reason: 'missing project identifier' });
    throw new errors.PolicyError('Missing project identifier', { policy: 'require-project-membership' });
  }

  // ----- membership check via COUNT (fast; no populate)
  const filters = slug
    ? { slug, users_permissions_users: { id: Number(user.id) } }
    : { documentId: String(documentId), users_permissions_users: { id: Number(user.id) } };

  const memberCount = await strapi.documents('api::project.project').count({ filters });

  // log the decision
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
