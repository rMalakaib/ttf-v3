export default {
  routes: [
    {
      method: 'GET',
      path: '/filings/:id/client-document/files',
      handler: 'filing.findClientDocumentFiles',
      config: {
        policies: [
          // keep your existing project membership policy if you have it
          'api::filing.require-project-membership',
        ],
        middlewares: [],
      },
    },
  ],
};
