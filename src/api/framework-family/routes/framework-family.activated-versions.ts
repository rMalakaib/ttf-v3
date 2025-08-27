// path: src/api/framework-family/routes/framework-family.activated-versions.ts
export default {
  routes: [
    {
      method: 'GET',
      path: '/framework-families/:id/versions/active',
      handler: 'framework-family.listActivatedForFamily',
      config: { policies: [], middlewares: [] },
    },
  ],
};
