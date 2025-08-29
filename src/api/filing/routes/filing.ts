// path: src/api/filing/routes/filing.ts
import { factories } from '@strapi/strapi';

/**
 * CRUD routes for Filings (project ↔ framework-version lifecycle).
 * Exposes:
 * GET    /filings
 * GET    /filings/:id
 * POST   /filings
 * PUT    /filings/:id
 * DELETE /filings/:id
 */
export default factories.createCoreRouter('api::filing.filing', {
  only: ['find', 'findOne', 'create', 'update', 'delete'],
  config: {
    find: { policies: [], middlewares: [] },
    findOne: { policies: [], middlewares: [] },
    create: { policies: [], middlewares: [] },
    update: { policies: [], middlewares: [] },
    delete: { policies: [], middlewares: [] },
  },
});
