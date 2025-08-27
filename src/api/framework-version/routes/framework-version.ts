// path: src/api/framework-version/routes/framework-version.ts
import { factories } from '@strapi/strapi';

/**
 * Read-only routes for FrameworkVersion.
 * Exposes:
 *   GET /framework-versions
 *   GET /framework-versions/:id
 */
export default factories.createCoreRouter('api::framework-version.framework-version', {
  only: ['find', 'findOne'],
  config: {
    find: { policies: [], middlewares: [] },
    findOne: { policies: [], middlewares: [] },
  },
});
