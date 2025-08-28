// path: src/api/client-document/controllers/client-document.ts
import { factories } from '@strapi/strapi';

const UID = 'api::client-document.client-document';

/** Local, Strapi-like query types (enough for our usage) */
type SortOrder = 'asc' | 'desc';
type Sort = string | Array<string | Record<string, SortOrder>>;
interface Pagination { page?: number; pageSize?: number; withCount?: boolean; }
interface QueryParams {
  filters?: any;
  populate?: any;
  sort?: Sort;
  pagination?: Pagination;
  fields?: string[];
}

/** Default populate (mutable objects/arrays; no `as const`) */
const defaultPopulate: QueryParams['populate'] = {
  document: true,
  users_permissions_user: { fields: ['id', 'username', 'email'] },
  filing: { fields: ['id', 'documentId', 'slug'] },
};

/** Build front-end friendly params: ?page=&pageSize=&filingId= */
function buildQueryOpts(q: Record<string, any> = {}): QueryParams {
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1);
  const pageSize = Math.max(1, parseInt(String(q.pageSize ?? '25'), 10) || 25);

  const filters: any = {};
  if (typeof q.filingId === 'string' && q.filingId.trim()) {
    filters.filing = { documentId: q.filingId.trim() };
  }

  // Use object-sort array (mutable), not readonly tuples
  const sort: Sort = [{ createdAt: 'desc' }];

  return {
    filters,
    populate: defaultPopulate,
    sort,
    pagination: { page, pageSize },
  };
}

/** Parse JSON or multipart form-data (`data` + `files.document`) */
function parseBody(ctx: any) {
  let data = (ctx.request?.body as any)?.data ?? ctx.request?.body ?? {};
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* ignore */ }
  }
  const files = (ctx.request as any)?.files ?? undefined;
  return { data, files };
}

export default factories.createCoreController(UID, ({ strapi }) => ({
  /** GET /api/client-documents?filingId=...&page=1&pageSize=25 */
  async find(ctx) {
    const opts = buildQueryOpts(ctx.request?.query as any);
    const rows = await strapi.documents(UID).findMany(opts as any); // cast keeps TS happy
    const sanitized = await this.sanitizeOutput(rows, ctx);
    return this.transformResponse(sanitized);
  },

  /** GET /api/client-documents/:id  (where :id is documentId) */
  async findOne(ctx) {
    const { id: documentId } = ctx.params;
    const entity = await strapi.service(UID).findOne(documentId, { populate: defaultPopulate as any });
    if (!entity) return ctx.notFound('ClientDocument not found');
    const sanitized = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitized);
  },

  /** POST /api/client-documents  (JSON or multipart) */
  async create(ctx) {
    const { data, files } = parseBody(ctx);
    const created = await strapi.service(UID).create({ data, files });
    const full = await strapi.service(UID).findOne(created.documentId, { populate: defaultPopulate as any });
    const sanitized = await this.sanitizeOutput(full, ctx);
    return this.transformResponse(sanitized);
  },

  /** PUT /api/client-documents/:id  (JSON or multipart) */
  async update(ctx) {
    const { id: documentId } = ctx.params;
    const { data, files } = parseBody(ctx);
    const updated = await strapi.service(UID).update(documentId, { data, files });
    const full = await strapi.service(UID).findOne(updated.documentId, { populate: defaultPopulate as any });
    const sanitized = await this.sanitizeOutput(full, ctx);
    return this.transformResponse(sanitized);
  },

  /** DELETE /api/client-documents/:id */
  async delete(ctx) {
    const { id: documentId } = ctx.params;
    const removed = await strapi.service(UID).delete(documentId);
    const sanitized = await this.sanitizeOutput(removed, ctx);
    return this.transformResponse(sanitized);
  },

  async deleteFiles(ctx) {
    const UID = 'api::client-document.client-document';
    const { id: documentId, ids } = ctx.params;

    if (typeof ids !== 'string' || !ids.trim()) {
        return ctx.badRequest('Provide comma-separated file ids in the path: /files/12,34');
    }

    // normalize :ids -> number[]
    const fileIds = ids
        .split(/[,\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));

    if (!fileIds.length) return ctx.badRequest('No valid numeric ids found in :ids.');

    // NOTE: only populate the real field name "document"
    const entry = await strapi.service(UID).findOne(documentId, { populate: { document: true } as any });
    if (!entry) return ctx.notFound('ClientDocument not found');

    // Your field is "document" and it's MULTIPLE (array)
    const isMulti = Array.isArray(entry.document);

    // Collect attached ids from "document"
    const attached = new Set<number>();
    if (isMulti) {
        for (const f of entry.document) if (f?.id) attached.add(Number(f.id));
    } else if (entry.document?.id) {
        attached.add(Number(entry.document.id));
    }

    const targets = fileIds.filter((id) => attached.has(id));
    const ignored = fileIds.filter((id) => !attached.has(id));
    if (!targets.length) {
        return ctx.badRequest('None of the provided ids are attached to this ClientDocument.');
    }

    // Delete assets (Upload plugin)
    for (const fid of targets) {
        await strapi.entityService.delete('plugin::upload.file', fid);
        // or: await strapi.service('plugin::upload.file').delete(fid);
    }

    // Unlink from the entry using the CORRECT key: "document"
    if (isMulti) {
        const keep = entry.document
        .filter((f: any) => !targets.includes(Number(f.id)))
        .map((f: any) => Number(f.id));
        await strapi.service(UID).update(documentId, { data: { document: keep } });
    } else {
        if (entry.document?.id && targets.includes(Number(entry.document.id))) {
        await strapi.service(UID).update(documentId, { data: { document: null } });
        }
    }

    return ctx.send({ deletedFileIds: targets, ignoredFileIds: ignored }, 200);
 },

}));
