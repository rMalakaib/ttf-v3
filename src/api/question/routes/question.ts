// path: src/api/question/routes/question.ts
import { factories } from '@strapi/strapi';

/**
 * Read-only routes for the Question catalogue.
 * Exposes:
 *   GET /questions
 *   GET /questions/:id
 */
export default factories.createCoreRouter('api::question.question', {
  only: ['find', 'findOne'],
  config: {
    find: { policies: [], middlewares: [] },
    findOne: { policies: [], middlewares: [] },
  },
});