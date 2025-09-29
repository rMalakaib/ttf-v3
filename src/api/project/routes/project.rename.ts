/**
 * Custom Project route — rename (slug)
 *
 * PATCH /projects/:projectId/rename  -> project.rename
 */
export default {
  routes: [
    {
      method: 'PUT',
      path: '/projects/:projectId/rename',
      handler: 'project.rename',
      config: {
        // Ensure only members (or stricter, depending on your policy) can rename
        policies: ['api::project.require-project-membership'],
        middlewares: [],
      },
    },
  ],
};
