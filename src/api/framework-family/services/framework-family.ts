// path: src/api/framework-family/services/framework-family.ts
import { factories } from '@strapi/strapi';

const UID_FAMILY = 'api::framework-family.framework-family';
const UID_VERSION = 'api::framework-version.framework-version';

type Pagination =
  | { page?: number; pageSize?: number; withCount?: boolean }
  | { start?: number; limit?: number };

export default factories.createCoreService(UID_FAMILY, ({ strapi }) => ({
  async listWithVersionIds({
    filters = {},
    sort = ['name:asc'],
    pagination,
  }: {
    filters?: Record<string, unknown>;
    sort?: string[];                 // array keeps TS happy
    pagination?: Pagination;
  } = {}) {
    // 1) fetch families only (no populate)
    const families = await strapi.documents(UID_FAMILY).findMany({
      fields: ['id', 'code', 'name'],
      filters,
      sort: ['name:asc'] as any,
      ...(pagination ? { pagination } : {}),
    });

    if (!Array.isArray(families) || families.length === 0) return families;

    // 2) for each family, fetch its top active version via findFirst
    const topVersions = await Promise.all(
      families.map((fam) =>
        strapi.documents(UID_VERSION).findFirst({
          filters: {
            isActive: true,
            // adjust the relation key if yours differs from 'framework_family'
            framework_family: { id: fam.id },
          },
          sort: ['version:desc'],
          fields: ['id', 'version', 'isActive'],
        })
      )
    );

    // 3) attach only the top version (if any)
    return families.map((fam, i) => ({
      ...fam,
      framework_versions: topVersions[i] ? [topVersions[i]] : [],
    }));
  },
}));
