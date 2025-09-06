import { factories } from '@strapi/strapi';
import { getMaxRounds, getNextSubmissionNumber } from '../../../utils/rounds';
import {
  quantizeToHalf,
  recomputeSubmissionScore,
} from '../../../utils/scoring';

type Id = string | number;

/** Best-effort activity logging wrapper (uses activity-log service). */
async function logActivity(
  strapi: any,
  action: 'edit' | 'score' | 'submit' | 'override' | 'lock',
  entityType: string,
  entityId: string,
  beforeJson?: any,
  afterJson?: any,
  userId?: number | null
) {
  try {
    await strapi.service('api::activity-log.activity-log').append({
      action,
      entityType,
      entityId,
      beforeJson,
      afterJson,
      userId: userId ?? undefined,
    });
  } catch {
    if (/^(1|true|on)$/i.test(String(process.env.SCORING_LOG ?? '0'))) {
      console.log('[activity fallback]', { action, entityType, entityId, afterJson });
    }
  }
}

/** Newest (isDraft:true) by question, including answerText for emptiness checks. */
async function collectNewestDraftsByQuestionWithText(
  strapi: any,
  filingDocumentId: string
): Promise<Record<string, any>> {
  const rows = await strapi.documents('api::answer-revision.answer-revision').findMany({
    publicationState: 'preview',
    filters: { isDraft: true, filing: { documentId: filingDocumentId } },
    fields: [
      'documentId',
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
      'updatedAt',
    ] as any,
    populate: {
      question: { fields: ['documentId'] as any },
      users_permissions_user: { fields: ['documentId'] as any },
    } as any,
    sort: ['updatedAt:desc'],
    pagination: { pageSize: 5000 },
  } as any);

  const byQ: Record<string, any> = {};
  for (const r of rows as any[]) {
    const qid = r?.question?.documentId;
    if (qid && !byQ[qid]) byQ[qid] = r; // take newest
  }
  return byQ;
}

/** Ensure every Question in the Filing's framework_version has a non-empty newest draft. */
async function assertAllQuestionsHaveDrafts(
  strapi: any,
  filingDocumentId: string
): Promise<{ questionIds: string[]; newestDrafts: Record<string, any> }> {
  const filing = await strapi.documents('api::filing.filing').findOne({
    documentId: filingDocumentId,
    fields: ['documentId'] as any,
    populate: {
      framework_version: {
        fields: ['documentId'] as any,
        populate: { questions: { fields: ['documentId'] as any } } as any,
      } as any,
    } as any,
  } as any);

  const questions = (filing?.framework_version?.questions ?? []) as any[];
  if (!questions.length) {
    throw Object.assign(new Error('No Questions found for framework_version'), { code: 'NO_QUESTIONS' });
  }
  const newestDrafts = await collectNewestDraftsByQuestionWithText(strapi, filingDocumentId);

  for (const q of questions) {
    const qid = q?.documentId as string;
    const draft = newestDrafts[qid];
    const text = String(draft?.answerText ?? '').trim();
    if (!draft || text.length === 0) {
      throw Object.assign(new Error(`Missing or empty draft for Question ${qid}`), {
        code: 'MISSING_DRAFT',
        questionId: qid,
      });
    }
  }

  return { questionIds: questions.map(q => q.documentId as string), newestDrafts };
}

/** Clone a draft AnswerRevision -> new non-draft snapshot (isDraft:false). */
async function cloneDraftToSnapshot(
  strapi: any,
  filingDocumentId: string,
  questionDocumentId: string,
  draft: any
): Promise<any> {
  // Compute next revisionIndex among non-draft siblings
  const last = await strapi.documents('api::answer-revision.answer-revision').findMany({
    publicationState: 'preview',
    filters: {
      isDraft: false,
      filing: { documentId: filingDocumentId },
      question: { documentId: questionDocumentId },
    },
    fields: ['revisionIndex'] as any,
    sort: ['revisionIndex:desc'],
    pagination: { pageSize: 1 },
  } as any);
  const nextIndex = Number((last as any[])?.[0]?.revisionIndex ?? 0) + 1;

  const data: any = {
    revisionIndex: nextIndex,
    isDraft: false,
    answerText: draft?.answerText ?? '',
    modelPromptRaw: draft?.modelPromptRaw ?? null,
    modelResponseRaw: draft?.modelResponseRaw ?? null,
    modelScore: draft?.modelScore ?? null,
    modelReason: draft?.modelReason ?? null,
    modelSuggestion: draft?.modelSuggestion ?? null,
    latencyMs: draft?.latencyMs ?? null,
    auditorScore: draft?.auditorScore ?? null,
    auditorReason: draft?.auditorReason ?? null,
    auditorSuggestion: draft?.auditorSuggestion ?? null,
    filing: { connect: [{ documentId: filingDocumentId }] },
    question: { connect: [{ documentId: questionDocumentId }] },
  };

  if (draft?.users_permissions_user?.documentId) {
    data.users_permissions_user = { connect: [{ documentId: draft.users_permissions_user.documentId }] };
  }

  const created = await strapi.documents('api::answer-revision.answer-revision').create({
    data,
    status: 'published',
  } as any);

  return created;
}

export default factories.createCoreService('api::submission.submission', ({ strapi }) => ({
  /**
   * Public contract: create a submission snapshot (idempotent).
   * - Validates readiness (non-empty drafts for all questions)
   * - Enforces MAX_ROUNDS dynamically
   * - Creates Submission (or reuses existing for same round)
   * - Creates per-question snapshots + SubmissionAnswer links (skips already-linked)
   * - Initializes submission.score from filing.currentScore, then confirms by recompute
   */
  async createSubmissionSnapshot(opts: {
    filingDocumentId: string;
    actorUserId?: Id | null;
    roundNumber?: number;
  }): Promise<{ submissionDocumentId: string; number: number }> {
    const { filingDocumentId, actorUserId } = opts;

    // 1) readiness check
    const { questionIds, newestDrafts } = await assertAllQuestionsHaveDrafts(strapi, filingDocumentId);

    // 2) determine round
    const MAX = getMaxRounds();
    const number = opts.roundNumber ?? (await getNextSubmissionNumber(strapi, filingDocumentId));
    if (number < 1 || number > MAX) {
      throw Object.assign(new Error(`Round ${number} is out of bounds (1..${MAX})`), {
        code: 'ROUND_OUT_OF_BOUNDS',
      });
    }

    // 3) idempotency: reuse if (filing, number) submission already exists
    let submission = await strapi.documents('api::submission.submission').findFirst({
      publicationState: 'preview',
      filters: { filing: { documentId: filingDocumentId }, number },
      fields: ['documentId', 'number', 'score'] as any,
      populate: [],
    } as any);

    if (!submission) {
      // create new
      submission = await strapi.documents('api::submission.submission').create({
        data: {
          number,
          submittedAt: new Date().toISOString(),
          filing: { connect: [{ documentId: filingDocumentId }] },
          users_permissions_user: actorUserId ? { connect: [{ id: actorUserId as any }] } : undefined,
        },
        status: 'published',
      } as any);
    }

    const submissionDocumentId: string = submission.documentId;

    // 4) ensure a single SubmissionAnswer per question (create missing links+snapshots)
    for (const qid of questionIds) {
      const existingLink = await strapi.documents('api::submission-answer.submission-answer').findFirst({
        publicationState: 'preview',
        filters: {
          submission: { documentId: submissionDocumentId },
          question: { documentId: qid },
        },
        fields: ['documentId'] as any,
        populate: [],
      } as any);
      if (existingLink) continue; // idempotent skip

      const draft = newestDrafts[qid];
      const snapshot = await cloneDraftToSnapshot(strapi, filingDocumentId, qid, draft);

      // create the link (treat unique-violation as harmless)
      try {
        await strapi.documents('api::submission-answer.submission-answer').create({
          data: {
            submission: { connect: [{ documentId: submissionDocumentId }] },
            question: { connect: [{ documentId: qid }] },
            answer_revision: { connect: [{ documentId: snapshot.documentId }] },
          },
          status: 'published',
        } as any);
      } catch (err: any) {
        // PG unique_violation 23505 -> safe to ignore (idempotent retry)
        if (!(err?.code === '23505')) throw err;
      }
    }

    // 5) initialize submission.score from filing.currentScore (rounded), then confirm by recompute
    const filing = await strapi.documents('api::filing.filing').findOne({
      documentId: filingDocumentId,
      fields: ['currentScore'] as any,
      populate: [],
    } as any);

    const initRounded = quantizeToHalf(Number(filing?.currentScore ?? 0));
    await strapi.documents('api::submission.submission').update({
      documentId: submissionDocumentId,
      data: { score: initRounded },
      status: 'published',
    } as any);

    await recomputeSubmissionScore(strapi, submissionDocumentId);

    await logActivity(
      strapi,
      'submit',
      'submission',
      submissionDocumentId,
      null,
      { submissionNumber: number, questionCount: questionIds.length },
      (actorUserId as number) ?? null
    );

    // Optional: trace that recompute occurred
    await logActivity(
      strapi,
      'edit',
      'submission',
      submissionDocumentId,
      null,
      { event: 'post-initial-recompute' },
      (actorUserId as number) ?? null
    );

    return { submissionDocumentId, number };
  },

  /** Public contract: recompute and persist this submission's score. */
  async recomputeSubmissionScore(submissionDocumentId: string): Promise<number> {
    const s = await recomputeSubmissionScore(strapi, submissionDocumentId);
    await logActivity(strapi, 'score', 'submission', submissionDocumentId, null, { score: s });
    return s;
  },

  /**
   * Carry-forward latest auditor guidance from the latest submission to current drafts.
   * Idempotent: only writes when fields differ.
   */
  async carryForwardAuditorGuidanceToDrafts(
    filingDocumentId: string
  ): Promise<{ updated: number }> {
    const latest = await strapi.documents('api::submission.submission').findMany({
      publicationState: 'preview',
      filters: { filing: { documentId: filingDocumentId } },
      fields: ['documentId', 'number'] as any,
      sort: ['number:desc'],
      pagination: { pageSize: 1 },
    } as any);
    const chosen = (latest as any[])?.[0];
    if (!chosen) return { updated: 0 };

    const links = await strapi.documents('api::submission-answer.submission-answer').findMany({
      publicationState: 'preview',
      filters: { submission: { documentId: chosen.documentId } },
      fields: ['documentId'] as any,
      populate: {
        question: { fields: ['documentId'] as any } as any,
        answer_revision: {
          fields: ['auditorScore', 'auditorReason', 'auditorSuggestion', 'documentId'] as any,
        } as any,
      } as any,
      pagination: { pageSize: 5000 },
    } as any);

    let updated = 0;
    for (const link of links as any[]) {
      const qid = link?.question?.documentId;
      const snap = link?.answer_revision;
      if (!qid || !snap) continue;

      const draft = await strapi.documents('api::answer-revision.answer-revision').findFirst({
        publicationState: 'preview',
        filters: { isDraft: true, filing: { documentId: filingDocumentId }, question: { documentId: qid } },
        sort: ['updatedAt:desc'],
        fields: ['documentId', 'auditorScore', 'auditorReason', 'auditorSuggestion'] as any,
        populate: [],
      } as any);
      if (!draft) continue;

      const sameScore = (draft.auditorScore ?? null) === (snap.auditorScore ?? null);
      const sameReason = String(draft.auditorReason ?? '') === String(snap.auditorReason ?? '');
      const sameSuggestion = String(draft.auditorSuggestion ?? '') === String(snap.auditorSuggestion ?? '');
      if (sameScore && sameReason && sameSuggestion) continue;

      await strapi.documents('api::answer-revision.answer-revision').update({
        documentId: draft.documentId,
        data: {
          auditorScore: snap.auditorScore ?? null,
          auditorReason: snap.auditorReason ?? null,
          auditorSuggestion: snap.auditorSuggestion ?? null,
        },
        status: 'published',
      } as any);

      updated++;
    }

    await logActivity(
      strapi,
      'edit',
      'filing',
      filingDocumentId,
      null,
      { event: 'carry_forward_guidance', updated }
    );

    return { updated };
  },

  /** Reset model fields on current drafts for a clean client-edit round.
 *  - If NO auditorScore: preserve modelScore; clear modelReason/modelSuggestion.
 *  - If HAS auditorScore: clear ALL model fields (modelScore -> 0; reasons/suggestions -> '').
 */
    async resetDraftModelFieldsForFiling(filingDocumentId: string): Promise<number> {
        const drafts = await strapi.documents('api::answer-revision.answer-revision').findMany({
            publicationState: 'preview',
            filters: { isDraft: true, filing: { documentId: filingDocumentId } },
            fields: ['documentId', 'auditorScore'] as any,
            populate: [],
            pagination: { pageSize: 5000 },
        } as any);

        let updated = 0;
        let clearedAll = 0;
        let clearedPartial = 0;

        for (const d of drafts as any[]) {
            const hasAuditor = d?.auditorScore != null;

            const data: any = {
            modelReason: '',
            modelSuggestion: '',
            };

            if (hasAuditor) {
            data.modelScore = null; // clear modelScore only when auditorScore exists
            clearedAll++;
            } else {
            clearedPartial++;
            }

            await strapi.documents('api::answer-revision.answer-revision').update({
            documentId: d.documentId,
            data,
            status: 'published',
            } as any);

            updated++;
        }

        await logActivity(
            strapi,
            'edit',
            'filing',
            filingDocumentId,
            null,
            { event: 'reset_draft_model_fields', updated, clearedAll, clearedPartial }
        );

        return updated;
    },
}));
