// path: src/api/framework-version/routes/custom-framework-version-filings.ts
export default {
  routes: [
    {
      method: 'GET',
      path: '/framework-versions/:id/filings',
      handler: 'framework-version.listFilingsForVersion',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};