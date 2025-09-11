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

// Build the compact [{id, url}] list from your media field
const mapUploadedFiles = (doc: any) => {
  const media = doc?.document;
  const arr = Array.isArray(media) ? media : (media ? [media] : []);
  return arr
    .filter((f: any) => f && f.id && f.url)
    .map((f: any) => ({ id: Number(f.id), url: String(f.url) }));
};


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
    const UID = 'api::client-document.client-document';
    const { id: documentId } = ctx.params;

    // 1) Read BEFORE to compute a delta later
    const before = await strapi.service(UID).findOne(documentId, {
      populate: { document: true, filing: true } as any,
    });

    // 2) Apply update (JSON or multipart)
    const { data, files } = parseBody(ctx);
    const updated = await strapi.service(UID).update(documentId, { data, files });

    // 3) Read AFTER with relations we need for the SSE
    const full = await strapi.service(UID).findOne(updated.documentId, {
      populate: { document: true, filing: true } as any,
    });

    // Helper to normalize [{id, url}]
    const mapUploadedFiles = (doc: any) => {
      const media = doc?.document;
      const arr = Array.isArray(media) ? media : (media ? [media] : []);
      return arr
        .filter((f: any) => f && f.id && f.url)
        .map((f: any) => ({ id: Number(f.id), url: String(f.url) }));
    };

    // 4) Compute the delta: only files added in THIS update
    const beforeIds = new Set((mapUploadedFiles(before) ?? []).map(f => f.id));
    const afterFiles = mapUploadedFiles(full);
    const addedFiles = afterFiles.filter(f => !beforeIds.has(f.id));

    // 5) Emit SSE with only the newly-added files
    try {
      const filingDocumentId =
        full?.filing?.documentId ?? full?.filing?.id ?? String(full?.filing);

      if (filingDocumentId) {
        await strapi.service('api::realtime-sse.pubsub').publish(
          `filing:${filingDocumentId}`,
          `filing:client-document:state:${filingDocumentId}:${documentId}:${Date.now()}`,
          'filing:client-document:state',
          {
            documentId,
            uploadedFiles: addedFiles,     // <<— now ONLY 205 & 206, not 203/204
            at: new Date().toISOString(),
          }
        );
      }
    } catch (e) {
      strapi.log.warn(`SSE publish failed (client-document:state, update): ${e?.message || e}`);
    }

    const sanitized = await this.sanitizeOutput(full, ctx);
    return this.transformResponse(sanitized);
  },

  /** DELETE /api/client-documents/:id */
  async delete(ctx) {
    const { id: documentId } = ctx.params;

    // Get filing id BEFORE the delete, since the record won’t exist afterward
    let filingDocumentId: string | undefined;
    try {
      const before = await strapi.service(UID).findOne(documentId, {
        populate: { filing: true } as any
      });
      filingDocumentId =
        before?.filing?.documentId ?? before?.filing?.id ?? String(before?.filing);
    } catch (_) { /* ignore */ }

    const removed = await strapi.service(UID).delete(documentId);

    // --- SSE: tell collaborators the document is now absent (empty file list) ---
      try {
        if (filingDocumentId) {
          await strapi.service('api::realtime-sse.pubsub').publish(
            `filing:${filingDocumentId}`,
            `filing:client-document:state:${filingDocumentId}`,
            'filing:client-document:state',
            { deletedClientDocument:documentId, at: new Date().toISOString() }
          );
        }
      } catch (e) {
        strapi.log.warn(`SSE publish failed (client-document:state, delete): ${e?.message || e}`);
      }

    const sanitized = await this.sanitizeOutput(removed, ctx);
    return this.transformResponse(sanitized);
  },

  // DELETE /api/client-documents/:id/files/:ids
// :ids is a comma- or space-separated list of upload file ids (numbers)
async deleteFiles(ctx) {
  const UID = 'api::client-document.client-document';
  const { id: documentId, ids } = ctx.params;

  // 1) Validate & normalize ids
  if (typeof ids !== 'string' || !ids.trim()) {
    return ctx.badRequest('Provide comma-separated file ids in the path: /files/12,34');
  }
  const fileIds = Array.from(
    new Set(
      ids.split(/[,\s]+/)
         .map((s) => Number(s))
         .filter((n) => Number.isFinite(n))
    )
  );
  if (!fileIds.length) return ctx.badRequest('No valid numeric ids found in :ids.');

  // 2) Read pre-delete state (must include filing to resolve topic)
  const entry = await strapi.service(UID).findOne(documentId, {
    populate: { document: true, filing: true } as any,
  });
  if (!entry) return ctx.notFound('ClientDocument not found');

  const isMulti = Array.isArray(entry.document);
  const currentFiles: any[] = isMulti
    ? (entry.document ?? [])
    : (entry.document ? [entry.document] : []);

  const attachedIds = new Set<number>();
  for (const f of currentFiles) if (f?.id) attachedIds.add(Number(f.id));

  const targets = fileIds.filter((id) => attachedIds.has(id));
  const ignored = fileIds.filter((id) => !attachedIds.has(id));
  if (!targets.length) {
    return ctx.badRequest('None of the provided ids are attached to this ClientDocument.');
  }

  // 3) Delta to emit (only the files being removed), from pre-delete state
  const removedFiles = currentFiles
    .filter((f: any) => f && targets.includes(Number(f.id)))
    .map((f: any) => ({ id: Number(f.id), url: String(f.url) }));

  // 4) Delete assets (Upload plugin) and unlink from the entry
  for (const fid of targets) {
    await strapi.entityService.delete('plugin::upload.file', fid);
  }

  if (isMulti) {
    const keep = currentFiles
      .filter((f: any) => !targets.includes(Number(f.id)))
      .map((f: any) => Number(f.id));
    await strapi.service(UID).update(documentId, { data: { document: keep } });
  } else {
    if (currentFiles[0]?.id && targets.includes(Number(currentFiles[0].id))) {
      await strapi.service(UID).update(documentId, { data: { document: null } });
    }
  }

  // 5) Emit delta (only removed files) to filing topic
  try {
    const filingDocumentId =
      entry?.filing?.documentId ?? entry?.filing?.id ?? String(entry?.filing);
    if (filingDocumentId && removedFiles.length) {
      await strapi.service('api::realtime-sse.pubsub').publish(
        `filing:${filingDocumentId}`,
        `filing:client-document:state:${filingDocumentId}:${documentId}:removed:${Date.now()}`, // id
        'filing:client-document:state',                                                         // event
        { documentId, removedFiles, at: new Date().toISOString() }                      // payload = delta
      );
    }
  } catch (e) {
    strapi.log.warn(`SSE publish failed (client-document:state, deleteFiles): ${e?.message || e}`);
  }

  return ctx.send({ deletedFileIds: targets, ignoredFileIds: ignored }, 200);
},


}));
