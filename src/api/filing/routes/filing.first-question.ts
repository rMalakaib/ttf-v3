export default {
  routes: [
    {
      method: 'GET',
      path: '/filings/:id/first-question',
      handler: 'filing.findFirstQuestion',
      config: { policies: [], middlewares: [] },
    },
  ],
} as const;
