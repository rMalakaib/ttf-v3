// path: src/api/filing/routes/filing-lifecycle.ts
/**
 * Custom Filing lifecycle routes.
 * - List filings by project
 * - Bootstrap creation by familyCode (query/body) or familyId (path)
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/projects/:projectId/filings',
      handler: 'filing.listByProject',
      config: { policies: [], middlewares: [] },
    },
    // One-shot bootstrap using familyCode via ?familyCode=... or JSON body { familyCode: "..." }
    {
      method: 'POST',
      path: '/projects/:projectId/filings/bootstrap',
      handler: 'filing.bootstrap',
      config: { policies: [], middlewares: [] },
    },
    // Optional: bootstrap using a family *documentId* in the path
    {
      method: 'POST',
      path: '/projects/:projectId/families/:familyId/filings/bootstrap',
      handler: 'filing.bootstrap',
      config: { policies: [], middlewares: [] },
    },
  ],
};
