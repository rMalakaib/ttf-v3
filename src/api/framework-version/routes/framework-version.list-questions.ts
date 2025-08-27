
// path: src/api/framework-version/routes/framework-version.list-questions.ts
export default {
  routes: [
    {
      method: 'GET',
      path: '/framework-versions/:id/questions',
      handler: 'framework-version.listQuestionsForVersion',
      config: { policies: [], middlewares: [] },
    },
  ],
};