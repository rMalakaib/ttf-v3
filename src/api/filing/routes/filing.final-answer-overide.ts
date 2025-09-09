// path: src/api/filing/routes/final-answer-override.ts
/**
 * POST /filings/:id/final/questions/:questionId/override-score
 * Body: { score: number }   // 'value' also accepted
 */
export default {
  routes: [
    {
      method: 'POST',
      path: '/filings/:id/final/questions/:questionId/override-score',
      handler: 'filing.overrideFinalAnswerScore',
      config: {
        policies: [
          'api::answer-revision.enforce-stage-editability',
        'api::filing.require-project-membership'],      // add auth/policies later
        middlewares: [],
      },
    },
  ],
};
