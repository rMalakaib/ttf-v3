export default {
  routes: [
    // GET draft (open read; add membership policy here too if you want to restrict reads)
    {
      method: 'GET',
      path: '/filings/:filingId/questions/:questionId/draft',
      handler: 'answer-revision.getDraft',
      config: {
        policies: [{ name: 'global::enforce-project-membership', config: { target: 'answer-revision' }}],           // optionally: [{ name:'global::enforce-project-membership', config:{ target:'answer-revision' } }]
        middlewares: [],
      },
    },

    // PUT draft (save + ChatGPT score): must be project member AND pass stage policy
    {
      method: 'PUT',
      path: '/filings/:filingId/questions/:questionId/draft',
      handler: 'answer-revision.saveDraft',
      config: {
        policies: [
          { name: 'global::enforce-project-membership', config: { target: 'answer-revision' } },
          'api::answer-revision.enforce-stage-editability',
        ],
        middlewares: [],
      },
    },

    // GET non-draft history (open read; add membership if you want)
    {
      method: 'GET',
      path: '/filings/:filingId/questions/:questionId/revisions',
      handler: 'answer-revision.listRevisions',
      config: {
        policies: [{ name: 'global::enforce-project-membership', config: { target: 'answer-revision' }}],           // optionally: [{ name:'global::enforce-project-membership', config:{ target:'answer-revision' } }]
        middlewares: [],
      },
    },
      {
    method: 'GET',
    path: '/filings/:filingId/questions/:questionId/lean-with-draft/from/:order',
    handler: 'answer-revision.leanWithDraftFromOrder',
    config: {
      policies: [
        { name: 'global::enforce-project-membership', config: { target: 'answer-revision' } }
      ],
      middlewares: [],
    },
  },

  ],
};
 