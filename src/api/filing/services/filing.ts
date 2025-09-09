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

async function createActivityLog(
  strapi: any,
  payload: TransitionLog,
  trx?: any
) {
  // Emit an app event (best-effort)
  try {
    strapi.eventHub?.emit?.('filing.status.transition', payload);
  } catch {
    /* ignore */
  }

  // Persist to an Activity-like CT if present; otherwise log to server logs
  const candidates = ['api::activity-log.activity-log', 'api::activity.activity'];
  const uid = candidates.find((u) => !!strapi.getModel?.(u));

  if (!uid) {
    try {
      strapi.log?.info?.(
        `[filing.transition] ${payload.filingDocumentId}: ${payload.prevStatus} -> ${payload.newStatus} by ${payload.actorRole} (${payload.action})`
      );
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    await strapi.documents(uid).create({
      data: {
        type: 'filing.status.transition',
        filingDocumentId: payload.filingDocumentId,
        prevStatus: payload.prevStatus,
        newStatus: payload.newStatus,
        actorRole: payload.actorRole,
        action: payload.action,
        actorUserId: payload.actorUserId ?? null,
        reason: payload.reason ?? null,
        context: payload.context ?? null,
        submissionDocumentId: payload.submissionDocumentId ?? null,
        occurredAt: new Date().toISOString(),
      },
      status: 'published',
      // @ts-ignore - supported at runtime
      transacting: trx as any,
    } as any);
  } catch (e) {
    try {
      strapi.log?.warn?.(`Activity log failed: ${(e as any)?.message ?? e}`);
    } catch {
      /* ignore */
    }
  }
}

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

      // 7) Activity log (best-effort)
      await createActivityLog(
        strapi,
        {
          filingDocumentId,
          prevStatus: from,
          newStatus: next,
          actorRole,
          action,
          actorUserId: actorUserId ?? null,
          reason: reason ?? null,
          context: { ...(context as any), spawnedDrafts: spawned.created ?? 0 },
          submissionDocumentId,
        },
        trx
      );

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
  }) {
    const { projectDocumentId, familyDocumentId, familyCode } = opts;
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
      },
      status: 'published',
    });

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
  

}));
