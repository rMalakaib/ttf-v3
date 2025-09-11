// path: src/api/client-document/routes/client-document.ts
import { factories } from '@strapi/strapi';

/**
 * CRUD routes for Client Documents (docs attached to projects).
 * Exposes:
 * GET    /client-documents
 * GET    /client-documents/:id
 * POST   /client-documents
 * PUT    /client-documents/:id
 * DELETE /client-documents/:id
 */
export default factories.createCoreRouter('api::client-document.client-document', {
  only: ['find', 'findOne', 'create', 'update', 'delete'],
  config: {
    find: {
      policies: ['api::client-document.require-project-membership'],
      middlewares: [],
    },
    findOne: {
      policies: ['api::client-document.require-project-membership'],
      middlewares: [],
    },
    create: {
      policies: ['api::client-document.require-project-membership'],
      middlewares: [],
    },
    update: {
      policies: ['api::client-document.require-project-membership'],
      middlewares: [],
    },
    delete: {
      policies: [],
      middlewares: [],
    },
  },
});
