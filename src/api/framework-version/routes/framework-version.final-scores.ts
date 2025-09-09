export default {
  routes: [
    {
      method: 'GET',
      path: '/framework-versions/:frameworkVersionId/final-scores',
      handler: 'framework-version.listFinalScores',
      config: {
        policies: [],          // add your membership policy here if you want to restrict reads
        middlewares: [],
      },
    },
  ],
};
