// path: src/api/framework-version/routes/framework-version.table-of-contents.ts

export default {
  routes: [
    {
      method: 'GET',
      path: '/framework-versions/:filingId/toc',
      handler: 'framework-version.listToc',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
} as const;