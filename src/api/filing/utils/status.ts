// path: src/api/filing/utils/status.ts
/**
 * Monotonic Filing Status (configurable).
 * - Ordered: draft → v1_submitted → … → vN_submitted → final
 * - No skips or reversals.
 * - Increase MAX_ROUNDS to allow more submitted rounds without changing logic.
 */

export const MAX_ROUNDS = 4; // ← ONLY EVER MAKE THIS NUMBER EVEN AND ABOVE 2.

// Type surface (broad, so runtime guard still enforces MAX_ROUNDS)
export type DraftStatus = 'draft';
export type FinalStatus = 'final';
export type SubmittedStatus = `v${number}_submitted`;
export type FilingStatus = DraftStatus | SubmittedStatus | FinalStatus;

// Build the ordered list from config (runtime)
export function buildStatusOrder(maxRounds: number = MAX_ROUNDS): readonly FilingStatus[] {
  const submitted: SubmittedStatus[] = Array.from({ length: maxRounds }, (_, i) => `v${i + 1}_submitted` as SubmittedStatus);
  return ['draft', ...submitted, 'final'] as const;
}

export const STATUS_ORDER = buildStatusOrder();

/** Parse helpers */
export function isSubmittedStatus(s: string): s is SubmittedStatus {
  return /^v\d+_submitted$/.test(s);
}

export function submittedIndex(s: SubmittedStatus): number {
  // v1_submitted → 1, v2_submitted → 2, ...
  const m = /^v(\d+)_submitted$/.exec(s);
  return m ? Number(m[1]) : NaN;
}

export function isValidStatus(s: string, maxRounds: number = MAX_ROUNDS): s is FilingStatus {
  if (s === 'draft' || s === 'final') return true;
  if (!isSubmittedStatus(s)) return false;
  const n = submittedIndex(s);
  return Number.isInteger(n) && n >= 1 && n <= maxRounds;
}

/** Ordering & navigation */
export function statusIndex(s: FilingStatus, maxRounds: number = MAX_ROUNDS): number {
  if (s === 'draft') return 0;
  if (s === 'final') return maxRounds + 1;
  const n = submittedIndex(s);
  return n; // 1..maxRounds
}

export function nextStatus(s: FilingStatus, maxRounds: number = MAX_ROUNDS): FilingStatus | null {
  if (s === 'draft') return ('v1_submitted' as SubmittedStatus);
  if (s === 'final') return null;
  const n = submittedIndex(s); // 1..maxRounds
  return n < maxRounds ? (`v${n + 1}_submitted` as SubmittedStatus) : 'final';
}

export type TransitionErrorCode =
  | 'INVALID_STATUS'
  | 'OUT_OF_RANGE'
  | 'BACKWARD'
  | 'SKIP'
  | 'NO_NEXT';

/**
 * Enforce "no skips, no reversals".
 * - Allowed only if nextIndex === prevIndex + 1.
 */
export function checkMonotonic(
  prev: string,
  next: string,
  maxRounds: number = MAX_ROUNDS
):
  | { ok: true; next: FilingStatus }
  | { ok: false; code: TransitionErrorCode; message: string } {
  if (!isValidStatus(prev, maxRounds) || !isValidStatus(next, maxRounds)) {
    return { ok: false, code: 'INVALID_STATUS', message: 'Unknown filing status' };
  }
  const p = statusIndex(prev, maxRounds);
  const n = statusIndex(next, maxRounds);

  if (prev === 'final') return { ok: false, code: 'NO_NEXT', message: 'Final is terminal' };
  if (n <= p) return { ok: false, code: 'BACKWARD', message: 'Cannot move backward or stay in place' };
  if (n !== p + 1) return { ok: false, code: 'SKIP', message: 'Cannot skip intermediate stages' };

  return { ok: true, next };
}

/** Convenience flags */
export function isFinal(s: FilingStatus): boolean { return s === 'final'; }
export function isClientEditStage(s: FilingStatus): boolean {
  // Even submissions (v2, v4, …) are client-edit stages
  if (!isSubmittedStatus(s)) return false;
  return submittedIndex(s) % 2 === 0;
}
export function isAuditorReviewStage(s: FilingStatus): boolean {
  // Odd submissions (v1, v3, …) are auditor-review stages
  if (!isSubmittedStatus(s)) return false;
  return submittedIndex(s) % 2 === 1;
}


export function isLastSubmittedRound(s: FilingStatus, maxRounds: number = MAX_ROUNDS): boolean {
  return isSubmittedStatus(s) && submittedIndex(s) === maxRounds;
}