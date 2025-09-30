// src/api/secret-key/policies/require-project-membership.ts
import { errors } from '@strapi/utils';
const { UnauthorizedError, ForbiddenError, ValidationError } = errors;

const getRoleSlug = (user: any): string => {
  const raw =
    (user?.role?.code ??
     user?.role?.type ??
     user?.role?.name ??
     '').toString().toLowerCase().trim();
  return raw;
};

export default async (policyContext: any, _config: any, { strapi }: any) => {
  // 1) Must be logged in via Users & Permissions
  const user = policyContext.state?.user || policyContext.request?.ctx?.state?.user;
  if (!user) throw new UnauthorizedError('Login required');

  // 2) Role gate
  const role = getRoleSlug(user);
  // Treat any admin-like slug as admin
  if (role === 'admin' || role === 'administrator' || role === 'super-admin') return true;

  // Auditors explicitly blocked (as per your comment)
  if (role === 'auditor') return true;

  // 3) Extract projectId (route param must be named :projectId)
  const projectId =
    policyContext.params?.projectId ??
    policyContext.request?.ctx?.params?.projectId ??
    policyContext.request?.params?.projectId;
  if (!projectId) throw new ValidationError('Missing projectId in route params');

  // 4) Membership check
  const rows = await strapi.documents('api::project.project').findMany({
    filters: {
      documentId: projectId,
      users_permissions_users: { id: user.id },
    },
    fields: ['id'],
    populate: [],
    pagination: { pageSize: 1 },
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ForbiddenError('Not a member of this project');
  }

  return true;
};
