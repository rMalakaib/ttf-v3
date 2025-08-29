// src/api/filing/services/filing.ts
import { factories } from '@strapi/strapi';
import { randomUUID } from 'node:crypto';

const INITIAL_STATUS = 'draft' as const;

export default factories.createCoreService('api::filing.filing', ({ strapi }) => ({
  async listByProject(opts: {
    projectDocumentId: string;
    filters?: any;
    sort?: any;
    fields?: any;
    pagination?: any;
  }) {
    const { projectDocumentId, filters = {}, sort, fields, pagination } = opts;

    return strapi.documents('api::filing.filing').findMany({
      filters: { ...(filters ?? {}), project: { documentId: projectDocumentId } },
      ...(fields ? { fields } : {}),
      ...(sort ? { sort } : {}),
      ...(pagination ? { pagination } : {}),
      populate: [],
    });
  },

  async bootstrap(opts: {
    projectDocumentId: string;
    familyDocumentId?: string;
    familyCode?: string;
  }) {
    const { projectDocumentId, familyDocumentId, familyCode } = opts;
    if (!familyDocumentId && !familyCode) throw new Error('Provide either familyDocumentId or familyCode');

    // 1) Latest active version in family (by docId or code)
    const familyRelationFilter = familyDocumentId
      ? { framework_family: { documentId: familyDocumentId } }
      : { framework_family: { code: familyCode } };

    const versions = await strapi.documents('api::framework-version.framework-version').findMany({
      filters: { isActive: true, ...familyRelationFilter },
      fields: ['id', 'version', 'isActive'] as const,
      populate: [],
      sort: ['version:desc'],
      pagination: { pageSize: 1 },
    });

    const version = Array.isArray(versions) && versions.length ? versions[0] : null;
    if (!version) throw new Error('No active FrameworkVersion found for the provided family');

    // 2) Create Filing as published
    const filing = await strapi.documents('api::filing.filing').create({
      data: {
        slug: randomUUID(),
        filingStatus: INITIAL_STATUS,
        currentScore: 0,
        project: { documentId: projectDocumentId },
        framework_version: { documentId: version.documentId },
      },
      status: 'published',
    });

    // 3) Fetch FIRST question (order asc, pageSize 1) and alias maxScore → score

    const first = await strapi.documents('api::question.question').findMany({
      filters: { framework_version: { documentId: version.documentId } },
      fields: [
            'id',
            'order',
            'header',
            'subheader',
            'prompt',
            'example',
            'guidanceMarkdown',
            'maxScore',
        ] as any,
      sort: ['order:asc'],
      populate: [],
      pagination: { pageSize: 1 },
    });

    const firstQuestion = Array.isArray(first) && first.length
      ? (({ maxScore, ...rest }: any) => ({ ...rest, score: maxScore }))(first[0])
      : null;

    return { filing, firstQuestion };
  },
}));
