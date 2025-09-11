// path: src/api/filing/controllers/filing.ts
import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::filing.filing', ({ strapi }) => ({
  async listByProject(ctx) {
    const { projectId } = ctx.params;
    const q = ctx.query as any;

    const rows = await strapi.service('api::filing.filing').listByProject({
      projectDocumentId: projectId,
      filters: q?.filters ?? {},
      sort: q?.sort,
      fields: q?.fields,
      pagination: q?.pagination,
    });

    const sanitized = await this.sanitizeOutput(rows, ctx);
    return this.transformResponse(sanitized);
  },

  async bootstrap(ctx) {
    const { projectId, familyId } = ctx.params;
    const q = ctx.query as any;
    const body = (ctx.request?.body ?? {}) as any;

    const familyDocumentId = familyId || undefined;
    const familyCode = (q?.familyCode ?? body?.familyCode) || undefined;

    const rawTitle = (q?.title ?? body?.title);
    const title = typeof rawTitle === 'string' && rawTitle.trim()
      ? rawTitle.trim().slice(0, 160) // keep it sane; adjust limit if you like
      : undefined;

    try {
      const { filing: rawFiling, firstQuestion } =
        await strapi.service('api::filing.filing').bootstrap({
          projectDocumentId: projectId,
          familyDocumentId,
          familyCode,
          title,
        });

      // Sanitize only the filing (matches this controller's model)
      const filing = rawFiling ? await this.sanitizeOutput(rawFiling, ctx) : null;

      // Return the first question as-is (already lean fields from the service)
      return this.transformResponse({ filing, firstQuestion });
    } catch (err: any) {
      return ctx.badRequest(typeof err?.message === 'string' ? err.message : 'Failed to create filing');
    }
  },

  /** POST /filings/:id/submit  (client → next auditor stage) */
  async submit(ctx) {
    const { id: filingDocumentId } = ctx.params;
    try {
      const updated = await strapi.service('api::filing.filing').transitionAtomic({
        filingDocumentId,
        actorRole: 'client',  // policies should ensure this route is client-only
        action: 'submit',
      });
      const sanitized = await this.sanitizeOutput(updated, ctx);
      return this.transformResponse(sanitized);
    } catch (err: any) {
      if (err?.code === 'CONFLICT') return ctx.conflict(err.message);
      if (err?.code === 'FORBIDDEN_ACTION') return ctx.forbidden(err.message);
      if (err?.code === 'NOT_FOUND') return ctx.notFound(err.message);
      return ctx.badRequest(err?.message ?? 'Submit failed');
    }
  },

  /** POST /filings/:id/advance (auditor → next client stage) */
  async advance(ctx) {
    const { id: filingDocumentId } = ctx.params;
    try {
      const updated = await strapi.service('api::filing.filing').transitionAtomic({
        filingDocumentId,
        actorRole: 'auditor', // policies should ensure this route is auditor-only
        action: 'advance',
      });
      const sanitized = await this.sanitizeOutput(updated, ctx);
      return this.transformResponse(sanitized);
    } catch (err: any) {
      if (err?.code === 'CONFLICT') return ctx.conflict(err.message);
      if (err?.code === 'FORBIDDEN_ACTION') return ctx.forbidden(err.message);
      if (err?.code === 'NOT_FOUND') return ctx.notFound(err.message);
      return ctx.badRequest(err?.message ?? 'Advance failed');
    }
  },

  /** POST /filings/:id/finalize (auditor → final) */
  async finalize(ctx) {
    const { id: filingDocumentId } = ctx.params;
    try {
      const updated = await strapi.service('api::filing.filing').transitionAtomic({
        filingDocumentId,
        actorRole: 'auditor', // policies should ensure this route is auditor-only
        action: 'finalize',
      });
      const sanitized = await this.sanitizeOutput(updated, ctx);
      return this.transformResponse(sanitized);
    } catch (err: any) {
      if (err?.code === 'CONFLICT') return ctx.conflict(err.message);
      if (err?.code === 'FORBIDDEN_ACTION') return ctx.forbidden(err.message);
      if (err?.code === 'NOT_FOUND') return ctx.notFound(err.message);
      return ctx.badRequest(err?.message ?? 'Finalize failed');
    }
  },

   async recomputeFinalScore(ctx) {
    const filingDocumentId = ctx.params?.id;
    if (!filingDocumentId) return ctx.badRequest('Missing filing documentId');

    // If you’re using users-permissions, this will be present when authenticated
    const userId = ctx.state?.user?.id ?? null;

    try {
      const result = await strapi
        .service('api::filing.filing')
        .recomputeFinalScore({ filingDocumentId, userId });

      ctx.body = { data: result };
    } catch (err) {
      const message = (err as any)?.message ?? 'Failed to recompute final score';
      ctx.badRequest(message);
    }
  },

  /**
   * POST /filings/:id/final/questions/:questionId/override-score
   * Body: { score:number }  // or { value:number }
   */
  async overrideFinalAnswerScore(ctx) {
    const filingDocumentId = ctx.params.id;
    const questionDocumentId = ctx.params.questionId;

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const raw = (body.score ?? body.value);
    const value = Number(raw);

    if (!Number.isFinite(value)) {
      return ctx.badRequest('Body must include a finite number: { "score": number }');
    }

    const result = await strapi
      .service('api::filing.filing')
      .overrideFinalAnswerScore({ filingDocumentId, questionDocumentId, value });

    ctx.body = result;
  },

  async delete(ctx) {
    const documentId = String(ctx.params?.id ?? '');
    if (!documentId) return ctx.badRequest('Missing filing documentId');

    // ---- prefetch projectId (for notifying the project channel) ----
    let projectId: string | undefined;
    try {
      const before = await strapi.documents('api::filing.filing').findOne({
        documentId,
        populate: { project: true },      // no fields:['documentId']; TS complains
      }) as any;
      projectId = before?.project?.documentId || undefined;
    } catch (e) {
      strapi.log?.debug?.(`[filing.delete] prefetch failed: ${e instanceof Error ? e.message : e}`);
    }

    // ---- helper: delete all docs by filters (typed as any to satisfy ContentType literal) ----
    const deleteAll = async (uid: string, filters: any, pageSize = 100) => {
      let total = 0;
      for (;;) {
        const rows = await (strapi.documents as any)(uid).findMany({
          filters,
          page: 1,
          pageSize,
        }) as any[];
        if (!rows?.length) break;

        for (const row of rows) {
          const docId = row?.documentId ?? row?.id;
          if (docId) {
            await (strapi.documents as any)(uid).delete({ documentId: String(docId) });
            total++;
          }
        }
        // iterate again from page 1 since we removed items
      }
      return total;
    };

    // ---- 1) delete children first (FK-safe order) ----
    try {
      // submission-answers linked via submission.filing OR answer_revision.filing
      await deleteAll('api::submission-answer.submission-answer', {
        $or: [
          { submission:      { filing: { documentId } } },
          { answer_revision: { filing: { documentId } } },
        ],
      });

      // submissions under this filing
      await deleteAll('api::submission.submission', {
        filing: { documentId },
      });

      // answer-revisions under this filing
      await deleteAll('api::answer-revision.answer-revision', {
        filing: { documentId },
      });

      // one-to-one client_document under this filing
      // NOTE: findOne() doesn't accept filters; use findMany() and take the first
      const clientDocs = await (strapi.documents as any)('api::client-document.client-document').findMany({
        filters: { filing: { documentId } },
        page: 1,
        pageSize: 1,
      }) as any[];

      const clientDocId = clientDocs?.[0]?.documentId;
      if (clientDocId) {
        await (strapi.documents as any)('api::client-document.client-document').delete({
          documentId: clientDocId,
        });
      }

      // (optional) if you also want to delete uploaded files attached to client_document.document:
      // const files: any[] = clientDocs?.[0]?.document ?? [];
      // for (const f of files) await (strapi.documents as any)('plugin::upload.file').delete({ documentId: f.documentId });
    } catch (e) {
      strapi.log?.warn?.(
        `[filing.delete] child cascade failed (continuing): ${e instanceof Error ? e.message : e}`
      );
    }

    // ---- 2) delete the filing itself ----
    const deleted = await strapi.documents('api::filing.filing').delete({ documentId });
    if (!deleted) return ctx.notFound('Filing not found');

    // ---- 3) publish + prune SSE topics (keep sockets alive) ----
    try {
      const pubsub: any = strapi.service('api::realtime-sse.pubsub');
      const payload = { filingId: documentId, projectId, at: new Date().toISOString() };

      pubsub.publish(`filing:${documentId}`, 'filing:deleted', payload);
      if (projectId) pubsub.publish(`project:${projectId}`, 'filing:deleted', payload);

      if (typeof pubsub.disconnectFilingChannels === 'function') {
        pubsub.disconnectFilingChannels(documentId);
      } else {
        if (typeof pubsub.disconnectTopic === 'function') {
          pubsub.disconnectTopic(`filing:${documentId}`);
        }
        if (typeof pubsub.disconnectTopicPrefix === 'function') {
          pubsub.disconnectTopicPrefix(`question:${documentId}:`);
        }
      }
    } catch (err) {
      strapi.log?.warn?.(
        `[filing.delete] publish/disconnect failed: ${err instanceof Error ? err.message : err}`
      );
    }

    return deleted;
  },
}));
