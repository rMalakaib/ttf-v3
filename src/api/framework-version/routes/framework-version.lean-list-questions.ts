// path: src/api/framework-version/routes/framework-version.lean-list-questions.ts

// Custom routes for Question reads
export default {
  routes: [
    {
      method: 'GET',
      path: '/framework-versions/:id/questions/lean',
      handler: 'framework-version.leanListByFrameworkVersion',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    // (optional) Prefetch "next N" questions after a given order
    {
      method: 'GET',
      path: '/framework-versions/:id/questions/lean/after/:order',
      handler: 'framework-version.leanListNextByOrder',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
} as const;
