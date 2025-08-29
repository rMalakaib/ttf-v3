// path: src/api/questions/routes/question.filing-status.ts

export default {
  routes: [
    // ...existing custom routes

    {
      method: 'GET',
      path: '/questions/:id/answer-revisions/latest-draft',
      handler: 'question.findLatestDraftAnswerRevision',
      config: { policies: [], middlewares: [] },
    },
  ],
} as const;
