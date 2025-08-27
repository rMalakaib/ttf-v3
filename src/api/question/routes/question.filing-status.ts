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
    {
      method: 'GET',
      path: '/questions/:id/answer-revisions/by-filing-status',
      handler: 'question.listAnswerRevisionsByFilingStatus',
      config: { policies: [], middlewares: [] },
    },
  ],
} as const;
