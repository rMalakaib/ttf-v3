import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::answer-revision.answer-revision', {
  only: ['find', 'findOne', 'create', 'update', 'delete'],
  config: {
    find:    { policies: [], middlewares: [] },
    findOne: { policies: [], middlewares: [] },

    // Writes: must be a project member (or auditor/admin) AND pass stage-editability
    create:  {
      policies: [
        { name: 'global::enforce-project-membership', config: { target: 'answer-revision' } },
        'api::answer-revision.enforce-stage-editability',
      ],
      middlewares: [],
    },
    update:  {
      policies: [
        { name: 'global::enforce-project-membership', config: { target: 'answer-revision' } },
        'api::answer-revision.enforce-stage-editability',
      ],
      middlewares: [],
    },
    delete:  {
      policies: [
        { name: 'global::enforce-project-membership', config: { target: 'answer-revision' } },
        'api::answer-revision.enforce-stage-editability',
      ],
      middlewares: [],
    },
  },
});
