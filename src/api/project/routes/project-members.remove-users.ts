// src/api/project/routes/project-members.remove-users.ts
export default {
  routes: [
    // Remove a specific member (admin/auditor only)
    {
      method: 'DELETE',
      path: '/projects/:projectId/members/:userId',
      handler: 'project.removeMember',
      config: {
        policies: ['api::project.require-project-membership'], // admin/auditor bypass; members must belong
        middlewares: [],
      },
    },
  ],
};
