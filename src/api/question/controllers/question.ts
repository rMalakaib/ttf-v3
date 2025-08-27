// path: src/api/question/controllers/question.ts
import { factories } from '@strapi/strapi';

const ANSWER_REVISION_SCALAR_FIELDS = [
  'id',
  'revisionIndex',
  'isDraft',
  'answerText',
  'modelPromptRaw',
  'modelResponseRaw',
  'modelScore',
  'modelReason',
  'modelSuggestion',
  'latencyMs',
  'auditorScore',
  'auditorReason',
  'auditorSuggestion',
  'createdAt',
  'updatedAt',
] as const;

const FILING_STATUS_ALL = [
  'draft',
  'v1_submitted',
  'v2_submitted',
  'v3_submitted',
  'v4_submitted',
  'final',
] as const;

type FilingStatus = typeof FILING_STATUS_ALL[number];
const FILING_STATUS_SET: ReadonlySet<FilingStatus> = new Set(FILING_STATUS_ALL);

// Type guard: narrows a string to FilingStatus
function isFilingStatus(s: string): s is FilingStatus {
  return FILING_STATUS_SET.has(s as FilingStatus);
}

export default factories.createCoreController('api::question.question', ({ strapi }) => ({
  /**
   * GET /api/questions
   * Tip: to fetch questions for a specific framework version, call:
   *   /api/questions?filters[framework_version][documentId]={versionId}
   */
  async find(ctx) {
    const entities = await strapi
      .documents('api::question.question')
      .findMany(ctx.query as any); // pass-through filters/sort/pagination/fields/populate

    const sanitized = await this.sanitizeOutput(entities, ctx);
    return this.transformResponse(sanitized);
  },

  /**
   * GET /api/questions/:id
   * ':id' is the documentId in Strapi v5.
   */
  async findOne(ctx) {
    const { id: documentId } = ctx.params;

    const entity = await strapi
      .service('api::question.question')
      .findOne(documentId, ctx.query as any);

    if (!entity) return ctx.notFound('Question not found');

    const sanitized = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitized);
  },
   /**
   * GET /questions/:id/answer-revisions
   * Lists all AnswerRevisions for a given Question documentId.
   * Optional: ?filing=<documentId> to scope to a filing.
   * Defaults to all non-relational fields; relations are not populated.
   * Supports fields/sort/pagination overrides.
   */
  async listAnswerRevisions(ctx) {
    const { id: questionDocumentId } = ctx.params;
    const q = ctx.query as any;

    const fields = q?.fields ?? [...ANSWER_REVISION_SCALAR_FIELDS];
    const sort = q?.sort ?? ['updatedAt:desc'];
    const pagination = q?.pagination ?? { pageSize: 100 };

    const filters: any = {
      ...(q?.filters ?? {}),
      question: { documentId: questionDocumentId },
    };
    if (q?.filing) {
      filters.filing = { documentId: q.filing };
    }

    const entities = await strapi
      .documents('api::answer-revision.answer-revision')
      .findMany({
        filters,
        fields,
        sort,
        populate: [], // <-- no relations
        pagination,
      });

    const sanitized = await this.sanitizeOutput(entities, ctx);
    return this.transformResponse(sanitized);
  },

  /**
   * GET /questions/:id/answer-revisions/latest
   * Returns the most recent AnswerRevision for a given Question documentId.
   * Recency: updatedAt desc, then createdAt desc.
   * Optional: ?filing=<documentId> to scope to a filing.
   * Defaults to all non-relational fields; relations are not populated.
   */
  async findLatestAnswerRevision(ctx) {
    const { id: questionDocumentId } = ctx.params;
    const q = ctx.query as any;

    const fields = q?.fields ?? [...ANSWER_REVISION_SCALAR_FIELDS];

    const filters: any = {
      ...(q?.filters ?? {}),
      question: { documentId: questionDocumentId },
    };
    if (q?.filing) {
      filters.filing = { documentId: q.filing };
    }

    const rows = await strapi
      .documents('api::answer-revision.answer-revision')
      .findMany({
        filters,
        fields,
        sort: ['updatedAt:desc', 'createdAt:desc'],
        populate: [], // <-- no relations
        pagination: { pageSize: 1 },
      });

    const entity = Array.isArray(rows) ? rows[0] : undefined;
    if (!entity) return ctx.notFound('Latest AnswerRevision not found');

    const sanitized = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitized);
  },

  /**
   * GET /questions/:id/answer-revisions/latest-draft
   * Returns the most recent AnswerRevision for a given Question (documentId) whose
   * related Filing has filingStatus = "draft".
   * Includes only non-relational AnswerRevision fields by default.
   * You can override fields via query (?fields[0]=...).
   */
  async findLatestDraftAnswerRevision(ctx) {
  const { id: questionDocumentId } = ctx.params;
  const q = ctx.query as any;
  const filingDocId = typeof q?.filing === 'string' ? q.filing : undefined;

  const fields = q?.fields ?? [...ANSWER_REVISION_SCALAR_FIELDS];

  const rows = await strapi
    .documents('api::answer-revision.answer-revision')
    .findMany({
      publicationState: 'preview',                 // ensure drafts are visible
      filters: {
        $and: [
          { question: { documentId: questionDocumentId } },
          { isDraft: true },
          ...(filingDocId ? [{ filing: { documentId: filingDocId } }] : []),
        ],
      },
      fields,
      populate: [],                                 // non-relational payload only
      sort: ['updatedAt:desc', 'createdAt:desc'],
      pagination: { pageSize: 1 },
    });

  const entity = Array.isArray(rows) ? rows[0] : undefined;
  if (!entity) return ctx.notFound('Draft AnswerRevision not found');

  const sanitized = await this.sanitizeOutput(entity, ctx);
  return this.transformResponse(sanitized);
},
  /**
 * GET /questions/:id/answer-revisions/by-filing-status
 * Returns ONE latest AnswerRevision per requested filing status for a Question (documentId).
 * Query: ?statuses=v1_submitted,final  (optional; defaults to all)
 */
  async listAnswerRevisionsByFilingStatus(ctx) {
    const { id: questionDocumentId } = ctx.params;
    const q = ctx.query as any;

    // Parse & narrow to the enum union
    const raw = typeof q?.statuses === 'string'
      ? q.statuses.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [...FILING_STATUS_ALL];

    // Dedupe + validate + NARROW to FilingStatus[]
    const wanted: FilingStatus[] = Array.from(new Set(raw)).filter(isFilingStatus);
    if (wanted.length === 0) {
      return this.transformResponse({ questionId: questionDocumentId, items: [] });
    }

    const fields = q?.fields ?? [...ANSWER_REVISION_SCALAR_FIELDS];

    // Pull newest-first revisions for the requested statuses
    const rows = await strapi
      .documents('api::answer-revision.answer-revision')
      .findMany({
        publicationState: 'preview',
        filters: {
          question: { documentId: questionDocumentId },
          filing: { filingStatus: { $in: wanted } }, // <- FilingStatus[] now, not string[]
        },
        fields,
        populate: { filing: { fields: ['filingStatus'] } },
        sort: ['updatedAt:desc', 'createdAt:desc'],
        pagination: { pageSize: 1000 },
      });

    // Keep newest per status
    const firstByStatus = new Map<FilingStatus, any>();
    for (const row of Array.isArray(rows) ? rows : []) {
      const status = row?.filing?.filingStatus as FilingStatus | undefined;
      if (!status) continue;
      if (!firstByStatus.has(status)) {
        const { filing, ...answerRevision } = row;
        firstByStatus.set(status, { status, answerRevision });
      }
    }

    const items = wanted.map(s => firstByStatus.get(s)).filter(Boolean);

    const sanitized = await this.sanitizeOutput({ questionId: questionDocumentId, items }, ctx);
    return this.transformResponse(sanitized);
  },

}));
