/**
 * Custom Filing "rename only" route.
 */
export default {
  routes: [
    {
      method: 'PATCH',
      path: '/projects/:projectId/filings/:id/rename',
      handler: 'filing.rename',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
