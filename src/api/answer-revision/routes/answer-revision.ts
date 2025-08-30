// path: src/api/answer-revision/routes/answer-revision.ts
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::answer-revision.answer-revision', {
  only: ['find', 'findOne', 'create', 'update', 'delete'],
  config: {
    find:    { policies: [], middlewares: [] },
    findOne: { policies: [], middlewares: [] },
    create:  { policies: ['api::answer-revision.enforce-stage-editability'], middlewares: [] },
    update:  { policies: ['api::answer-revision.enforce-stage-editability'], middlewares: [] },
    delete:  { policies: ['api::answer-revision.enforce-stage-editability'], middlewares: [] }, // optional
  },
});
