// Utility routes — not tied to a content type
export default {
  routes: [
    {
      method: 'GET',
      path: '/health',
      handler: 'health.index',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/health/liveness',
      handler: 'health.liveness',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/health/readiness',
      handler: 'health.readiness',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
