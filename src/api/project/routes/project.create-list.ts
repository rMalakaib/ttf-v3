// path: src/api/project/routes/project-custom.ts
/**
 * Custom Project routes — create/join/me
 *
 * POST /projects/create  -> project.create       (create Project + initial key)
 * POST /projects/join    -> project.join         (join via token/secret)
 * GET  /me/projects      -> project.getMeProjects (caller’s client projects)
 */
export default {
  routes: [
    {
      method: 'POST',
      path: '/projects/create',
      handler: 'project.create',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'POST',
      path: '/projects/join',
      handler: 'project.join',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/me/projects',
      handler: 'project.getMeProjects',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/projects/slug/:slug',
      handler: 'project.getBySlug',
      config: {
        policies: [],    // e.g., add a read policy if needed
        middlewares: [], // e.g., caching, rate-limit, etc.
    },},
    {
      method: 'GET',
      path: '/projects/:projectId/filings',
      handler: 'project.listFilingIds',
      config: {
        policies: [],    // add membership/auditor policies as needed
        middlewares: [],
      },
    },
  ],
};
