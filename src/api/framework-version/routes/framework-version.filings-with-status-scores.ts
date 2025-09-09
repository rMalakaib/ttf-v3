export default {
  routes: [
    {
      method: 'GET',
      path: '/framework-versions/:frameworkVersionId/filings-with-scores',
      handler: 'framework-version.listFilingsWithScores',
      config: {
        policies: [],   // add a read policy if you want to restrict visibility
        middlewares: [],
      },
    },
  ],
};
 