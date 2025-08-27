// path: src/api/questions/routes/question.list-answerrevisions.ts

export default {
  routes: [

    {
      method: 'GET',
      path: '/questions/:id/answer-revisions',
      handler: 'question.listAnswerRevisions',
      config: { policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/questions/:id/answer-revisions/latest',
      handler: 'question.findLatestAnswerRevision',
      config: { policies: [], middlewares: [] },
    },
  ],
} as const;