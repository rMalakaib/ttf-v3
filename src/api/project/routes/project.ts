// path: src/api/project/routes/project.ts
import { factories } from '@strapi/strapi';

/**
 * Core read routes for Project.
 * Exposes:
 *   GET /projects/:id -> project.findOne
 * (Add 'find' if you ever want GET /projects)
 */
export default factories.createCoreRouter('api::project.project', {
  only: ['findOne', 'find', 'delete'],
  config: {
    findOne: { policies: ['api::project.require-project-membership'], middlewares: [] },
    delete: { policies: ['api::project.require-project-membership'], middlewares: [] },
  },
});
