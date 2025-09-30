export default {
  routes: [
    {
      method: 'GET',
      path: '/filings/:id/score-summary',
      handler: 'filing.scoreSummary',
      config: { policies: [], middlewares: [] },
    },
  ],
} as const;
