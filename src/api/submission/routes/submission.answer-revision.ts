export default {
  routes: [
    {
      method: 'GET',
      // Scopes the submission "number" to a specific filing, and targets a specific question
      path: '/filings/:filingDocumentId/submissions/:number/questions/:questionDocumentId/answer-revision',
      handler: 'api::submission.submission.answerRevisionForQuestion',
      config: {
        policies: [
            'api::filing.require-project-membership'
          // Add your membership/role policies here if you have them, e.g.:
          // 'global::require-client-membership',
          // 'api::filing.enforce-read-access',
        ],
      },
    },
  ],
};
