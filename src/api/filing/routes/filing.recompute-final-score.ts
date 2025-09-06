export default {
  routes: [
    {
      method: 'POST',
      path: '/filings/:id/recompute-final-score',
      handler: 'filing.recomputeFinalScore',
      config: {
        policies: [],      // add auth here if you want (e.g., 'global::require-auth')
        middlewares: [],   // rate limit / logging, etc.
      },
    },
  ],
};