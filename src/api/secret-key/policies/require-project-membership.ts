// path: src/api/secret-key/policies/require-project-membership.ts
// Allows: admin (always), authenticated project members (only for the given project).
// Denies: auditor (never allowed), unauthenticated users, non-members.
// Expects routes shaped like: /projects/:projectId/secret-keys/...

export default async (policyContext: any, _config: any, { strapi }: any) => {
  // 1) Must be logged in
  const user = policyContext.state?.user || policyContext.request?.ctx?.state?.user;
  if (!user) return false;

  // 2) Role gate
  const role = String(user?.role?.name ?? '').trim().toLowerCase();
  if (role === 'admin' || role === 'administrator') return true; // bypass
  if (role === 'auditor') return false; // auditors never touch secret keys

  // 3) Extract projectId from params
  const projectId =
    policyContext.params?.projectId ??
    policyContext.request?.ctx?.params?.projectId ??
    policyContext.request?.params?.projectId;
  if (!projectId) return false;

  // 4) Membership check: does this user belong to the project?
  // (We filter by relation rather than populating to keep it cheap.)
  const rows = await strapi.documents('api::project.project').findMany({
    filters: {
      documentId: projectId,
      users_permissions_users: { id: user.id },
    },
    fields: ['id'],
    populate: [],
    pagination: { pageSize: 1 },
  });

  return Array.isArray(rows) && rows.length > 0;
};
