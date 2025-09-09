export default {
  routes: [
    {
      method: 'GET',
      path: '/filings/:id/latest-submission-score',
      handler: 'api::submission.submission.latestSubmissionScore',
      config: {
        policies: ['api::filing.require-project-membership'],      // add your auth/policies here if needed
        middlewares: [],   // add rate limiting or transforms if desired
      },
    },
  ],
};
