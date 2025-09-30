// path: src/api/filing/services/filing.ts
import { factories } from '@strapi/strapi';
import { randomUUID } from 'node:crypto';
import { computeSnapshotRoundForTransition } from '../utils/submission-hooks';
import { recomputeFilingFinalScore } from '../../../utils/scoring';
import { recomputeFilingCurrentScore } from '../../../utils/scoring';


import {
  MAX_ROUNDS,
  nextStatus,
  isValidStatus,
  statusIndex,
  isAuditorReviewStage,
  isClientEditStage,
  submittedIndex,
  type FilingStatus,
} from '../utils/status';
import {
  allowedActionsFor,
  type ActorRole,
  type Action,
} from '../utils/roles';


type GetClientFilesArgs = {
  filingDocumentId: string;
};

/**
 * Minimal Upload file shape used by the frontend
 */
type MinimalFile = {
  id: string;
  url: string;
  name: string;
  mime: string;
  size: number;
  thumbUrl?: string;
};




const INITIAL_STATUS = 'draft' as const;

/* =================================================================== */
/* Step 12: Standardized service errors                                 */
/* =================================================================== */
export type ServiceErrorCode =
  | 'INVALID_STATUS'     // unknown/unsupported status, or out of configured rounds
  | 'FORBIDDEN_ACTION'   // role not allowed to perform this action at this stage
  | 'NO_NEXT'            // terminal state; no next status
  | 'BACKWARD'           // attempted backwards or no-op transition
  | 'SKIP'               // attempted multi-step/skipped transition
  | 'PREREQ_FAILED'      // missing prerequisites (e.g., empty drafts)
  | 'LOCK_VIOLATION'     // active lock prevents transition
  | 'CONFLICT'           // optimistic concurrency/race detected
  | 'NOT_FOUND';         // entity not found

export class ServiceError extends Error {
  code: ServiceErrorCode;
  details?: unknown;
  constructor(code: ServiceErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function httpStatusFor(code: ServiceErrorCode): number {
  switch (code) {
    case 'FORBIDDEN_ACTION':
      return 403;
    case 'CONFLICT':
    case 'LOCK_VIOLATION':
      return 409;
    case 'NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}

export function isServiceError(err: unknown): err is ServiceError {
  return err instanceof ServiceError;
}

/* =================================================================== */
/* Step 13: Transition logging helper                                   */
/* =================================================================== */
type TransitionLog = {
  filingDocumentId: string;
  prevStatus: FilingStatus;
  newStatus: FilingStatus;
  actorRole: ActorRole;
  action: Action;
  actorUserId?: number | string | null;
  reason?: string | null;
  context?: unknown;
  submissionDocumentId?: string | null;
};


/* =================================================================== */
/* Step 14: Spawn client drafts from prior submitted snapshots          */
/* =================================================================== */

/**
 * When moving auditor → client (odd → even), create fresh draft AnswerRevisions by
 * cloning the last submitted snapshots (revisionIndex = submittedIndex(from)).
 * - New drafts get revisionIndex = submittedIndex(from) + 1
 * - Copies client/model fields + auditor guidance
 * - Skips creation if target drafts already exist (idempotent)
 */
// REPLACE the whole function body with the version below (same signature & imports)
  /* =================================================================== */
/* Step 14: Spawn/refresh client drafts from prior submitted snapshots  */
/*  - Overwrite existing draft per (filing, question); create if none  */
/* =================================================================== */
async function spawnDraftsForNextClientStage(opts: {
    strapi: any;
    trx: any;
    filingDocumentId: string;
    from: FilingStatus; // auditor-review stage (v1, v3, …)
    to: FilingStatus;   // client-edit stage (v2, v4, …)
  }): Promise<{ updated: number; created: number }> {
    const { strapi, trx, filingDocumentId, from, to } = opts;

    if (!(isAuditorReviewStage(from) && isClientEditStage(to))) {
      return { updated: 0, created: 0 };
    }

    const prevRound = submittedIndex(from as any); // 1,3,5...
    const targetRound = prevRound + 1;             // 2,4,6...

    // Pull prior round snapshots (one per question)
    const snapshots = await strapi.documents('api::answer-revision.answer-revision').findMany({
      publicationState: 'preview',
      filters: {
        filing: { documentId: filingDocumentId },
        isDraft: false,
        revisionIndex: prevRound,
      },
      fields: [
        'documentId',
        'revisionIndex',
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
      ] as any,
      populate: { question: { fields: ['documentId'] as any } } as any,
      pagination: { pageSize: 1000 },
      // @ts-ignore
      transacting: trx as any,
    } as any);

    let updated = 0;
    let created = 0;

    for (const snap of Array.isArray(snapshots) ? snapshots : []) {
      const qDocId = snap?.question?.documentId;
      if (!qDocId) continue;

      // Try to find an existing draft for this (filing, question)
      const existingDraft = await strapi.documents('api::answer-revision.answer-revision').findFirst({
        publicationState: 'preview',
        filters: {
          isDraft: true,
          filing: { documentId: filingDocumentId },
          question: { documentId: qDocId },
        },
        fields: ['documentId'] as any,
        // @ts-ignore
        transacting: trx as any,
      } as any);

      const payload: any = {
        // keep drafts as isDraft:true; bump revisionIndex to target round
        revisionIndex: targetRound,
        isDraft: true,

        // carry forward client/model content
        answerText: snap.answerText ?? '',
        modelPromptRaw: snap.modelPromptRaw ?? null,
        modelResponseRaw: snap.modelResponseRaw ?? null,
        modelScore: snap.modelScore ?? null,
        modelReason: snap.modelReason ?? null,
        modelSuggestion: snap.modelSuggestion ?? null,
        latencyMs: snap.latencyMs ?? null,

        // carry forward auditor guidance as read-only context
        auditorScore: snap.auditorScore ?? null,
        auditorReason: snap.auditorReason ?? null,
        auditorSuggestion: snap.auditorSuggestion ?? null,
      };

      if (existingDraft?.documentId) {
        // OVERWRITE existing draft
        await strapi.documents('api::answer-revision.answer-revision').update({
          documentId: existingDraft.documentId,
          data: payload,
          status: 'published',
          // @ts-ignore
          transacting: trx as any,
        } as any);
        updated++;
      } else {
        // CREATE the single draft for this (filing, question)
        await strapi.documents('api::answer-revision.answer-revision').create({
          data: {
            ...payload,
            filing: { connect: [{ documentId: filingDocumentId }] },
            question: { connect: [{ documentId: qDocId }] },
          },
          status: 'published',
          // @ts-ignore
          transacting: trx as any,
        } as any);
        created++;
      }
    }

    return { updated, created };
  }

  /* =================================================================== */
/* Step 14b: Recompute currentScore inside the current transaction      */
/* =================================================================== */
async function recomputeCurrentScoreTx(
  strapi: any,
  trx: any,
  filingDocumentId: string
): Promise<number> {
  const rows = await strapi.documents('api::answer-revision.answer-revision').findMany({
    publicationState: 'preview',
    filters: { isDraft: true, filing: { documentId: filingDocumentId } },
    fields: ['modelScore', 'auditorScore', 'updatedAt'] as any,
    populate: { question: { fields: ['documentId'] as any } } as any,
    sort: ['updatedAt:desc'],
    pagination: { pageSize: 5000 },
    // @ts-ignore
    transacting: trx as any,
  } as any);

  const seen = new Set<string>();
  let total = 0;
  for (const r of rows as any[]) {
    const qid = r?.question?.documentId;
    if (!qid || seen.has(qid)) continue;
    seen.add(qid);
    const ms = r?.modelScore;
    const as = r?.auditorScore;
    const v = ms != null ? Number(ms) : (as != null ? Number(as) : 0);
    if (Number.isFinite(v)) total += v;
  }

  const rounded = Math.round(total * 2) / 2;

  await strapi.documents('api::filing.filing').update({
    documentId: filingDocumentId,
    data: { currentScore: rounded },
    status: 'published',
    // @ts-ignore
    transacting: trx as any,
  } as any);

  return rounded;
}


function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// Parse vN_submitted -> N, otherwise null (draft/final/unknown)
function submissionNumberFromStatus(status?: string | null): number | null {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (s === 'draft' || s === 'final') return null;
  const m = /^v(\d+)_submitted$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mirrors the submission controller logic, with an optional round filter.
 * - If `roundNumber` is provided, fetch that exact submission number.
 * - Otherwise, return the latest by number desc, submittedAt desc.
 * Returns 0 if none found (keeps summary endpoint simple).
 */
async function getSubmissionScore(
  strapi: any,
  filingDocumentId: string,
  roundNumber?: number | null
): Promise<number> {
  const base: any = {
    publicationState: 'preview',
    filters: { filing: { documentId: filingDocumentId } },
    fields: ['documentId', 'number', 'submissionScore', 'submittedAt'] as any,
    populate: [],
  };

  let sub: any | null = null;

  if (Number.isFinite(roundNumber as number)) {
    // Specific round (e.g., v3_submitted => number = 3)
    const rows = await strapi.documents('api::submission.submission').findMany({
      ...base,
      filters: { ...base.filters, number: Number(roundNumber) },
      sort: ['submittedAt:desc'], // if multiple for same number, pick most recent
      pagination: { pageSize: 1 },
    } as any);
    sub = Array.isArray(rows) ? rows[0] : null;
  } else {
    // Latest overall (final or unspecified)
    sub = await strapi.documents('api::submission.submission').findFirst({
      ...base,
      sort: ['number:desc', 'submittedAt:desc'],
    } as any);
  }

  if (!sub) return 0;

  const scoreNum = sub.submissionScore == null ? 0 : Number(sub.submissionScore);
  return Number.isFinite(scoreNum) ? scoreNum : 0;
}

/* =================================================================== */
/* Service                                                              */
/* =================================================================== */
export default factories.createCoreService('api::filing.filing', ({ strapi }) => ({

  /* ---------------------------------------------------------------
   * Step 5: Central transition guard (throws ServiceError)
   * --------------------------------------------------------------- */
  computeNext(opts: {
    current: string;
    actorRole: ActorRole;
    action: Action;
  }): { next: FilingStatus } {
    const { current, actorRole, action } = opts;

    if (!isValidStatus(current, MAX_ROUNDS)) {
      throw new ServiceError('INVALID_STATUS', `Unknown filing status: ${current}`);
    }
    const curr = current as FilingStatus;

    const allowed = allowedActionsFor(curr, actorRole, MAX_ROUNDS);
    if (!allowed.includes(action)) {
      throw new ServiceError(
        'FORBIDDEN_ACTION',
        `Role '${actorRole}' cannot '${action}' from '${curr}'`
      );
    }

    const candidate: FilingStatus | null =
      action === 'finalize' ? 'final' : nextStatus(curr, MAX_ROUNDS);

    if (!candidate) {
      throw new ServiceError('NO_NEXT', `No next status from '${curr}'`);
    }

    // Enforce "no skips / no reversals"
    const prevIdx = statusIndex(curr, MAX_ROUNDS);
    const nextIdx = statusIndex(candidate, MAX_ROUNDS);
    if (nextIdx <= prevIdx) {
      throw new ServiceError('BACKWARD', `Cannot move backward or stay in place (${curr} → ${candidate})`);
    }
    if (nextIdx !== prevIdx + 1) {
      throw new ServiceError('SKIP', `Cannot skip intermediate stage (${curr} → ${candidate})`);
    }

    return { next: candidate };
  },

  /* ---------------------------------------------------------------
   * Step 6 (+13 +14): Atomic transition + logging + draft spawn
   * --------------------------------------------------------------- */
  async transitionAtomic(opts: {
    filingDocumentId: string;
    actorRole: ActorRole;             // 'client' | 'auditor' | 'admin'
    action: Action;                   // 'submit' | 'advance' | 'finalize'
    actorUserId?: number | string;    // optional, for logging
    reason?: string;                  // optional, for logging
    context?: unknown;                // optional, for logging
  }) {
    const { filingDocumentId, actorRole, action, actorUserId, reason, context } = opts;

    return await strapi.db.transaction(async (trx: any) => {
      // 1) Read current state inside the transaction
      const pre = await strapi.documents('api::filing.filing').findOne({
        documentId: filingDocumentId,
        fields: [
          'id',
          'documentId',
          'filingStatus',
          'updatedAt',
          'firstSubmitAt',
          'finalizedAt',
        ] as any,
        populate: [],
        // @ts-ignore - supported at runtime
        transacting: trx as any,
      } as any);

      if (!pre) throw new ServiceError('NOT_FOUND', 'Filing not found');

      const from = pre.filingStatus as FilingStatus;

      // 2) Decide the next status via the guard
      const { next } = this.computeNext({ current: from, actorRole, action });

      // 3) Prerequisites (locks/completeness/etc.)
      await this.assertTransitionPrereqs?.({ trx, filing: pre, from, to: next, action });

      // 4) Side-effects
      // 4a) Stage-aware draft spawning: only on auditor → client (odd → even)
      let spawned = { created: 0 };
      if (isAuditorReviewStage(from) && isClientEditStage(next)) {
        spawned = await spawnDraftsForNextClientStage({
          strapi,
          trx,
          filingDocumentId,
          from,
          to: next,
        });
      }

      // 4b) Custom hook (e.g., snapshot Submission)

      function coerceActorUserId(id: unknown): number | undefined {
        const n =
          typeof id === 'number' ? id :
          typeof id === 'string' ? Number(id) :
          NaN;
        return Number.isFinite(n) ? n : undefined;
      }

      const actorId = coerceActorUserId(actorUserId);

      const sideEffectsResult = await this.runTransitionSideEffects?.({
        trx,
        filing: pre,
        from,
        to: next,
        action,
        actorUserId: actorId,
      });

      // Safely narrow (void | { submissionDocumentId?: string })
      const submissionDocumentId: string | null =
        sideEffectsResult && typeof sideEffectsResult === 'object' && 'submissionDocumentId' in sideEffectsResult
          ? (sideEffectsResult as { submissionDocumentId?: string }).submissionDocumentId ?? null
          : null;

      // 5) Verify unchanged (optimistic concurrency)
      const check = await strapi.documents('api::filing.filing').findOne({
        documentId: filingDocumentId,
        fields: ['filingStatus', 'updatedAt'] as any,
        populate: [],
        // @ts-ignore - supported at runtime
        transacting: trx as any,
      } as any);

      if (!check) throw new ServiceError('NOT_FOUND', 'Filing not found');
      if (check.filingStatus !== pre.filingStatus || check.updatedAt !== pre.updatedAt) {
        throw new ServiceError('CONFLICT', 'Filing changed during transition');
      }

      // 6) Apply update (stamp edge fields exactly once)
      const stamps: Record<string, any> = {};
      if (from === 'draft' && next === 'v1_submitted' && !pre.firstSubmitAt) {
        stamps.firstSubmitAt = new Date().toISOString();
      }
      if (next === 'final' && !pre.finalizedAt) {
        stamps.finalizedAt = new Date().toISOString();
      }

      const updated = await strapi.documents('api::filing.filing').update({
        documentId: filingDocumentId,
        data: { filingStatus: next, ...stamps },
        status: 'published',
        // @ts-ignore - supported at runtime
        transacting: trx as any,
      } as any);
      
      // 6a) Post-write: if we just entered 'final', compute and persist the finalScore
      if (next === 'final') {
        const id = updated?.documentId ?? filingDocumentId;

        const toNum = (v: unknown) =>
          typeof v === 'number' ? v :
          typeof v === 'string' ? Number(v) :
          NaN;

        const userIdNum = Number.isFinite(toNum(actorUserId)) ? Number(toNum(actorUserId)) : null;
        // console.log('typeof recomputeFilingFinalScore', typeof recomputeFilingFinalScore);
        await recomputeFilingFinalScore(strapi, id, { userId: userIdNum });

        // ⬇️ re-fetch outside the transaction context so the response includes the new finalScore
        const fresh = await strapi.documents('api::filing.filing').findOne({
          documentId: id,
          fields: ['finalScore'] as any,
          populate: [],
          // IMPORTANT: no `transacting: trx` here — we want the latest committed value
        } as any);

        (updated as any).finalScore = fresh?.finalScore ?? null;
      }



      // 6b) Post-write: if we just entered a client-edit stage (even round), carry-forward + reset
      if (isClientEditStage(next)) {
        const id = updated?.documentId ?? filingDocumentId; // <- use a real id in scope

        await strapi.service('api::submission.submission')
          .carryForwardAuditorGuidanceToDrafts(id);

        await strapi.service('api::submission.submission')
          .resetDraftModelFieldsForFiling(id);
      }

      // 6c) Recompute currentScore when we enter a client-edit stage (auditor → client)
      if (isClientEditStage(next)) {
        const newScore = await recomputeCurrentScoreTx(strapi, trx, updated?.documentId ?? filingDocumentId);
        (updated as any).currentScore = newScore;
      }

      try {
        const id = filingDocumentId;
        const payload = {
          from,                                   // FilingStatus
          to: next as FilingStatus,               // FilingStatus
          documentId: id,
          at: new Date().toISOString(),
        };

        // Deterministic-ish message id for replay/dedupe
        const msgId = `filing:status:${id}`;

        await strapi.service('api::realtime-sse.pubsub').publish(
          `filing:${id}`,          // topic
          msgId,                   // id
          'filing:status',         // event
          payload                  // payload
        );
      } catch (err) {
        // Do not block the transaction on SSE fanout failures
        strapi.log.warn?.(`SSE publish failed for filing:status ${filingDocumentId}: ${String((err as any)?.message || err)}`);
      }

      return updated;
    });
  },

  /** Optional prerequisite hook — throw ServiceError('PREREQ_FAILED' | 'LOCK_VIOLATION', msg) as needed */
  async assertTransitionPrereqs(_opts: {
    trx: any;
    filing: any;
    from: FilingStatus;
    to: FilingStatus;
    action: Action;
  }) {
    // no-op for now
  },

  /** Optional side-effects hook — creates Submission snapshots when required */
  /** Optional side-effects hook — creates Submission snapshots when required */
  async runTransitionSideEffects(opts: {
      trx: any;
      filing: any;
      from: FilingStatus;          // ← use canonical type
      to: FilingStatus;            // ← use canonical type
      action: string;              // your Action type if you have one
      actorUserId?: number | null; // keep numeric user id (null if unknown)
    }): Promise<{ submissionDocumentId?: string } | void> {
      const { filing, from, to, actorUserId } = opts;

      // Decide if this transition requires a snapshot; computes the exact round number.
      const roundNumber = computeSnapshotRoundForTransition(from, to);
      if (roundNumber == null) return; // no-op

      const { submissionDocumentId } = await strapi
        .service('api::submission.submission')
        .createSubmissionSnapshot({
          filingDocumentId: filing.documentId,
          actorUserId: actorUserId ?? null,
          roundNumber, // strict 1..MAX_ROUNDS inside the submission service
        });

      return { submissionDocumentId };
    },

  /* ---------------------------------------------------------------
   * Existing helpers
   * --------------------------------------------------------------- */
  

  async bootstrap(opts: {
    projectDocumentId: string;
    familyDocumentId?: string;
    familyCode?: string;
    title?: string;
  }) {
    const { projectDocumentId, familyDocumentId, familyCode, title } = opts;
    if (!familyDocumentId && !familyCode) {
      throw new ServiceError('PREREQ_FAILED', 'Provide either familyDocumentId or familyCode');
    }

    // 1) Latest active version in family (by docId or code)
    const familyRelationFilter = familyDocumentId
      ? { framework_family: { documentId: familyDocumentId } }
      : { framework_family: { code: familyCode } };

    const versions = await strapi.documents('api::framework-version.framework-version').findMany({
      filters: { isActive: true, ...familyRelationFilter },
      fields: ['id', 'version', 'isActive'] as any,
      populate: [],
      sort: ['version:desc'],
      pagination: { pageSize: 1 },
    });

    const version = Array.isArray(versions) && versions.length ? versions[0] : null;
    if (!version) throw new ServiceError('PREREQ_FAILED', 'No active FrameworkVersion found for the provided family');

    // 2) Create Filing as published
    const filing = await strapi.documents('api::filing.filing').create({
      data: {
        slug: randomUUID(),
        filingStatus: INITIAL_STATUS,
        currentScore: 0,
        project: { documentId: projectDocumentId },
        framework_version: { documentId: version.documentId },
        ...(title ? { title } : {}),
      },
      status: 'published',
    });

    // 2a) Create an empty ClientDocument linked to this filing (best-effort)
    try {
      const filingDocId = (filing as any)?.documentId ?? (filing as any)?.id;

      await strapi.documents('api::client-document.client-document').create({
        data: {
          filing: { documentId: String(filingDocId) }, // one-to-one link
          // document: []            // implicit empty
          // users_permissions_user: { connect: [Number(ctx.state.user.id)] } // optional if you pass a user
        },
        status: 'published',
        
      });
      
    } catch (e: any) {
      strapi.log?.warn?.(`[bootstrap] client-document create failed: ${e?.message ?? e}`);
    }

    /** --- SSE: project:filing:created -------------------------------------- */
    try {
      
      const filingId = (filing as any)?.documentId ?? (filing as any)?.id;
      const title = String((filing as any)?.title ?? '');
      const status = (filing as any)?.filingStatus;

      await strapi.service('api::realtime-sse.pubsub').publish(
        `project:${projectDocumentId}`,
        `project:filing:created:${filingId}`,
        'project:filing:created',
        { projectId: projectDocumentId, documentId: filingId, title: title, status: status, at: new Date().toISOString() }
      );
    } catch (err) {
      // Non-fatal: creation succeeded; if publish/logging fails we just continue.
      strapi.log.warn(`[SSE] project:filing:created emit failed: ${err?.message ?? err}`);
    }
  /** ---------------------------------------------------------------------- */

    // 3) First question (lean)
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
        'questionType',
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

    /* ---------------------------------------------------------------
   *  recompute final score outside of a transition
   * --------------------------------------------------------------- */
  async recomputeFinalScore(opts: { filingDocumentId: string; userId?: number | null }) {
    const { filingDocumentId, userId = null } = opts;
    return await recomputeFilingFinalScore(strapi, filingDocumentId, { userId });
  },
  /**
   * For a FINAL filing, set modelScore & auditorScore on the *specific* answerRevision
   * (for the given question) that was snapshotted into the last submission,
   * mirror the same into that submission-answer snapshot, then recompute finalScore.
   */
  async overrideFinalAnswerScore(opts: {
    filingDocumentId: string;
    questionDocumentId: string;
    value: number;
    log?: boolean;
  }) {
    const { filingDocumentId, questionDocumentId, value, log = true } = opts;

    // 1) Filing must be FINAL
    const filing = await strapi.documents('api::filing.filing').findOne({
      documentId: filingDocumentId,
      fields: ['documentId', 'filingStatus'] as any,
    } as any);
    if (!filing) throw new Error(`Filing not found: ${filingDocumentId}`);
    if (filing.filingStatus !== 'final') {
      throw new Error(`Filing must be in 'final' status (got '${filing.filingStatus}')`);
    }

    // 2) Get highest-numbered submission
    const [finalSub] = await strapi.documents('api::submission.submission').findMany({
      publicationState: 'preview',
      filters: { filing: { documentId: filingDocumentId } },
      fields: ['documentId', 'number'] as any,
      sort: ['number:desc'],
      pagination: { pageSize: 1 },
    } as any);
    if (!finalSub) throw new Error(`No submissions found for filing=${filingDocumentId}`);

    // 3) Find the submission-answer for this question on that final submission.
    //    IMPORTANT: schema uses 'answer_revision' (underscore)
    const [sa] = (await strapi
      .documents('api::submission-answer.submission-answer')
      .findMany({
        publicationState: 'preview',
        filters: {
          submission: { documentId: finalSub.documentId },
          $or: [
            { question: { documentId: questionDocumentId } },
            { answer_revision: { question: { documentId: questionDocumentId } } },
          ],
        },
        // no 'modelScore'/'auditorScore' fields on submission-answer
        fields: ['documentId'] as any,
        populate: ['answer_revision', 'answer_revision.question'] as any,
        pagination: { pageSize: 1 },
      } as any)) as Array<any>;

    if (!sa) {
      throw new Error(
        `Final submission has no submission-answer for question=${questionDocumentId}`
      );
    }

    // 4) Update ONLY the authoritative AnswerRevision (camelCase fields exist here)
    const arDocId: string | undefined = sa?.answer_revision?.documentId;
    if (!arDocId) throw new Error(`submission-answer lacks linked answer_revision`);
    await strapi.documents('api::answer-revision.answer-revision').update({
      documentId: arDocId,
      data: {
        modelScore: Number(value),   // if your DB requires string for decimals, use String(value)
        auditorScore: Number(value),
      },
      status: 'published',
    } as any);

    // 5) Recompute finalScore (see small tweak in util below)
    const { finalScore, modelTotal, auditedPrevTotal } = await recomputeFilingFinalScore(
      strapi,
      filingDocumentId,
      { log }
    );

    return {
      filingDocumentId,
      finalSubmissionDocumentId: finalSub.documentId,
      questionDocumentId,
      answerRevisionDocumentId: arDocId,
      overriddenScore: Number(value),
      finalScore,
      modelTotal,
      auditedPrevTotal,
    };
  },
  
  /**
   * Resolve Filing -> Framework Version -> lowest-ordered Question.
   */
   async getFirstQuestionForFiling({
    filingDocumentId,
    fields,
  }: {
    filingDocumentId: string;
    fields?: readonly string[];
  }) {
    // ✅ Use service().findOne(id, params)
    const filing = await strapi.service('api::filing.filing').findOne(filingDocumentId, {
      publicationState: 'preview' as any,
      fields: ['documentId'] as any,
      populate: {
        framework_version: { fields: ['documentId'] as any },
      } as any,
    } as any);

    if (!filing) return null;

    // ✅ Cast to any (or define a type) to access populated relation
    const frameworkVersionId = (filing as any)?.framework_version?.documentId;
    if (!frameworkVersionId) return null;

    // Fetch the lowest-ordered question for that framework version
    const rows = await strapi.documents('api::question.question').findMany({
      publicationState: 'preview',
      filters: { framework_version: { documentId: frameworkVersionId } },
      fields: (fields ?? [
        'documentId',
        'order',
        'header',
        'subheader',
        'prompt',
        'guidanceMarkdown',
        'questionType',
        'example',
        'maxScore',
        'modelPrompt',
        'createdAt',
        'updatedAt',
      ]) as any,
      sort: ['order:asc', 'createdAt:asc'],
      populate: [],
      pagination: { pageSize: 1 },
    } as any);

    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  },


   /**
   * Returns minimal files (id, url, name, mime, size, thumbUrl?) for the client-document
   * linked to a given filing documentId.
   *
   * null if no client-document exists for the filing.
   */
  async getClientDocumentFilesMinimal(
    args: GetClientFilesArgs
  ): Promise<{ clientDocumentId: string; files: MinimalFile[] } | null> {
    const { filingDocumentId } = args;

    // Find the client-document for this filing; populate the 'document' media
    const clientDocs = await (strapi.documents as any)(
      'api::client-document.client-document'
    ).findMany({
      filters: { filing: { documentId: filingDocumentId } },
      page: 1,
      pageSize: 1,
      populate: {
        document: {
          fields: [
            'id',
            'documentId',
            'url',
            'name',
            'mime',
            'size',
            'formats', // for thumbnail (if image)
          ],
        },
      },
    }) as any[];

    if (!clientDocs?.length) return null;

    const clientDoc = clientDocs[0];
    const clientDocumentId: string =
      clientDoc?.documentId ?? clientDoc?.id ?? '';

    const filesRaw: any[] = Array.isArray(clientDoc?.document)
      ? clientDoc.document
      : [];

    const files: MinimalFile[] = filesRaw
      .filter(Boolean)
      .map((f) => {
        const id = String(f?.documentId ?? f?.id ?? '');
        const url = String(f?.url ?? '');
        const name = String(f?.name ?? '');
        const mime = String(f?.mime ?? '');
        const size = Number.isFinite(f?.size) ? Number(f.size) : 0;

        // Optional thumbnail (if images with formats)
        const thumbUrl = f?.formats?.thumbnail?.url
          ? String(f.formats.thumbnail.url)
          : undefined;

        return { id, url, name, mime, size, ...(thumbUrl ? { thumbUrl } : {}) };
      });

    return { clientDocumentId, files };
  },




   /**
 * Compute { currentScore, submissionScore, maxScore } for a filing.
 * - maxScore = framework_version.totalScore
 * - submissionScore depends on ?status:
 *   - draft => 0
 *   - final => latest submission
 *   - vN_submitted => submission for round N
 * - currentScore override:
 *   - if status === 'final' => use filing.finalScore (fallback to filing.currentScore)
 */
async computeScoreSummary(opts: {
  filingDocumentId: string;
  status?: string;
}): Promise<{
  filingDocumentId: string;
  currentScore: number;
  submissionScore: number;
  maxScore: number;
}> {
  const { filingDocumentId, status } = opts;

  // 1) Load filing (need currentScore, finalScore, framework_version.totalScore)
  const filing = await strapi.service('api::filing.filing').findOne(filingDocumentId, {
    publicationState: 'preview' as any,
    fields: ['documentId', 'currentScore', 'finalScore'] as any, // ← include finalScore
    populate: {
      framework_version: { fields: ['documentId', 'totalScore'] as any },
    } as any,
  } as any);

  if (!filing) {
    throw new Error(`Filing not found: ${filingDocumentId}`);
  }

  const s = status ? String(status).toLowerCase() : undefined;

  // Base scores from filing
  const baseCurrent = toNum((filing as any).currentScore);
  const baseFinal = toNum((filing as any).finalScore); // may be null/undefined
  const maxScore = toNum((filing as any)?.framework_version?.totalScore);

  // 2) Determine submissionScore by status
  let submissionScore = 0;
  if (s === 'draft') {
    submissionScore = 0;
  } else if (s === 'final') {
    // Latest submission when final
    submissionScore = await getSubmissionScore(strapi, filingDocumentId, null);
  } else {
    // vN_submitted -> N, else latest
    const round = submissionNumberFromStatus(s);
    submissionScore = await getSubmissionScore(strapi, filingDocumentId, round);
  }

  // 3) currentScore override when status=final
  const currentScore =
    s === 'final'
      ? (Number.isFinite(baseFinal) ? baseFinal : baseCurrent)
      : baseCurrent;

  return {
    filingDocumentId,
    currentScore,
    submissionScore,
    maxScore,
  };
},
}));
