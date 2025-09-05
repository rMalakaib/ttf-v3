// path: src/utils/scoring.ts

// Toggle debug logs with env SCORING_LOG=1 (default: off)
const LOG_ON = /^(1|true|on)$/i.test(String(process.env.SCORING_LOG ?? '0'));

/**
 * Prefer modelScore, else auditorScore, else 0.
 */
export function effectiveDraftScore(row: any): number {
  const ms = row?.modelScore;
  const as = row?.auditorScore;
  const v = ms != null ? Number(ms) : (as != null ? Number(as) : 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Did the per-question effective score change?
 */
export function hasScoreChanged(prev?: number | null, next?: number | null): boolean {
  const p = prev == null ? 0 : Number(prev);
  const n = next == null ? 0 : Number(next);
  return Math.abs(p - n) > 1e-9;
}

/**
 * Round to nearest 0.5 (… .0, .5, 1.0, 1.5, …)
 */
export function quantizeToHalf(total: number): number {
  return Math.round(total * 2) / 2;
}

/**
 * Fetch newest drafts (isDraft:true) for a filing, keeping only the latest per Question.
 * Returns an array of draft rows (one per question).
 */
export async function collectNewestDraftsByQuestion(
  strapi: any,
  filingDocumentId: string
): Promise<any[]> {
  const rows = await strapi
    .documents('api::answer-revision.answer-revision')
    .findMany({
      publicationState: 'preview',
      filters: { isDraft: true, filing: { documentId: filingDocumentId } },
      fields: ['documentId', 'modelScore', 'auditorScore', 'updatedAt'] as any,
      populate: { question: { fields: ['documentId'] as any } } as any,
      sort: ['updatedAt:desc'], // newest first; we'll pick first per question in code
      pagination: { pageSize: 5000 }, // generous cap
    } as any);

  const byQuestion: Record<string, any> = {};
  for (const r of rows as any[]) {
    const qid = r?.question?.documentId;
    if (!qid) continue;
    if (!byQuestion[qid]) byQuestion[qid] = r; // keep first (newest) we see
  }
  const kept = Object.values(byQuestion);
  if (LOG_ON) console.log('[scoring] kept drafts:', kept.length, 'of', rows?.length ?? 0);
  return kept as any[];
}

/**
 * Recompute and persist Filing.currentScore from newest drafts per question.
 *
 * Rule:
 *  - per-question: modelScore ?? auditorScore ?? 0
 *  - sum, then round to nearest 0.5
 *
 * Writes filing.currentScore and returns the rounded value.
 */
export async function recomputeFilingCurrentScore(
  strapi: any,
  filingDocumentId: string,
  opts?: { log?: boolean }
): Promise<number> {
  const log = opts?.log ?? LOG_ON;

  const drafts = await collectNewestDraftsByQuestion(strapi, filingDocumentId);

  let total = 0;
  for (const d of drafts) total += effectiveDraftScore(d);

  const rounded = quantizeToHalf(total);

  const filing = await strapi.documents('api::filing.filing').findOne({
  documentId: filingDocumentId,
  fields: ['currentScore'] as any,
  populate: [],
    } as any);

    // ...after computing `rounded`
    if (Number(filing?.currentScore ?? 0) === rounded) {
    if (log) console.log('[scoring] no-op (unchanged)', { filingDocumentId, rounded });
    return rounded; // 🔇 skip update
    }

  await strapi
    .documents('api::filing.filing')
    .update({
      documentId: filingDocumentId,
      data: { currentScore: rounded },
      status: 'published',
    } as any);

  if (log) {
    console.log('[scoring] recompute currentScore', {
      filingDocumentId,
      questions: drafts.length,
      totalRaw: total,
      totalRounded: rounded,
    });
  }

  return rounded;
}

/* ========================= Submissions: helpers & recompute ========================= */

/** Prefer auditorScore for snapshots (isDraft:false); else modelScore; else 0. */
export function effectiveSnapshotScore(row: any): number {
  const as = row?.auditorScore;
  const ms = row?.modelScore;
  const v = as != null ? Number(as) : (ms != null ? Number(ms) : 0);
  return Number.isFinite(v) ? v : 0;
}

/** Load snapshot AnswerRevisions (isDraft:false) via SubmissionAnswer links. */
export async function collectSubmissionSnapshots(
  strapi: any,
  submissionDocumentId: string
): Promise<any[]> {
  const links = await strapi.documents('api::submission-answer.submission-answer').findMany({
    publicationState: 'preview',
    filters: { submission: { documentId: submissionDocumentId } },
    fields: ['documentId'] as any,
    populate: {
      answer_revision: {
        fields: ['documentId', 'isDraft', 'modelScore', 'auditorScore', 'updatedAt'] as any,
      } as any,
    } as any,
    pagination: { pageSize: 5000 },
  } as any);

  const out: any[] = [];
  for (const l of links as any[]) {
    const rev = l?.answer_revision;
    if (rev?.isDraft === false) out.push(rev);
  }
  return out;
}

/**
 * Recompute and persist Submission.score from its snapshots.
 *  - per-question: auditorScore ?? modelScore ?? 0
 *  - sum, then round to nearest 0.5
 *  - append ActivityLog when score actually changes
 */
export async function recomputeSubmissionScore(
  strapi: any,
  submissionDocumentId: string,
  opts?: { log?: boolean; userId?: number | null }
): Promise<number> {
  const log = opts?.log ?? LOG_ON;

  const snaps = await collectSubmissionSnapshots(strapi, submissionDocumentId);

  let total = 0;
  for (const s of snaps) total += effectiveSnapshotScore(s);
  const rounded = quantizeToHalf(total);

  const sub = await strapi.documents('api::submission.submission').findOne({
    documentId: submissionDocumentId,
    fields: ['score', 'number'] as any,
    populate: { filing: { fields: ['documentId'] as any } } as any,
  } as any);

  const before = Number(sub?.score ?? 0);
  if (before === rounded) {
    if (log) console.log('[scoring] submission no-op (unchanged)', { submissionDocumentId, rounded });
    return rounded;
  }

  await strapi.documents('api::submission.submission').update({
    documentId: submissionDocumentId,
    data: { score: rounded },
    status: 'published',
  } as any);

  // Activity: score delta
  try {
    await strapi.service('api::activity-log.activity-log').append({
      action: 'score',
      entityType: 'submission',
      entityId: submissionDocumentId,
      beforeJson: { score: before },
      afterJson: { score: rounded },
      userId: opts?.userId ?? undefined,
    });
  } catch (_) {}

  if (log) {
    console.log('[scoring] recompute submission.score', {
      submissionDocumentId,
      questions: snaps.length,
      totalRaw: total,
      totalRounded: rounded,
    });
  }
  return rounded;
}