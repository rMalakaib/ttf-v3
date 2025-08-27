// path: src/api/framework-family/routes/framework-family.ts
import { factories } from '@strapi/strapi';

/**
 * Read-only routes for the FrameworkFamily catalogue.
 * Exposes:
 *   GET /framework-families
 *   GET /framework-families/:id
 */
export default factories.createCoreRouter('api::framework-family.framework-family', {
  only: ['find', 'findOne'],
  config: {
    find: { policies: [], middlewares: [] },
    findOne: { policies: [], middlewares: [] },
  },
});
