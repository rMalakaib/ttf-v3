// path: src/api/filing/routes/filing-lifecycle.ts
/**
 * Custom Filing lifecycle routes.
 * - List filings by project
 * - Bootstrap creation by familyCode (query/body) or familyId (path)
 */
export default {
  routes: [
    // One-shot bootstrap using familyCode via ?familyCode=... or JSON body { familyCode: "..." }
    {
      method: 'POST',
      path: '/projects/:projectId/filings/bootstrap',
      handler: 'filing.bootstrap',
      config: { policies: ['api::project.require-project-membership'], middlewares: [] },
    },
    // Optional: bootstrap using a family *documentId* in the path
    {
      method: 'POST',
      path: '/projects/:projectId/families/:familyId/filings/bootstrap',
      handler: 'filing.bootstrap',
      config: { policies: ['api::project.require-project-membership'], middlewares: [] },
    },
  ],
};
