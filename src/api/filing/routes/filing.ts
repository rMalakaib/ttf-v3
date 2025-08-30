// path: src/api/filing/routes/filing.ts
import { factories } from '@strapi/strapi';

/**
 * CRUD routes for Filings.
 */
export default factories.createCoreRouter('api::filing.filing', {
  only: ['find', 'findOne', 'create', 'update', 'delete'],
  config: {
    find:   { policies: [], middlewares: [] },
    findOne:{ policies: [], middlewares: [] },
    create: {
      policies: [],
      // Block attempts to set filingStatus at creation time
      middlewares: ['api::filing.block-filingstatus'],
    },
    update: {
      policies: [],
      // Block attempts to set filingStatus via generic update
      middlewares: ['api::filing.block-filingstatus'],
    },
    delete: { policies: [], middlewares: [] },
  },
});
