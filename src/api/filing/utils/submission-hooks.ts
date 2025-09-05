// Orchestration helpers for Filing status transitions.
// NOTE: This file intentionally reuses logic from ./status (no reimplementations).

import {
  MAX_ROUNDS,
  isSubmittedStatus,
  submittedIndex,
  isFinal,
  isClientEditStage,
  type FilingStatus,
} from './status';

/**
 * If the transition (prev -> next) mandates a submission snapshot, return the round number.
 * Rules:
 *  - draft -> v1_submitted        => create round 1
 *  - even submitted -> odd submitted (e.g., v2 -> v3, v4 -> v5) => create the odd round
 *  - last even -> final (only if MAX_ROUNDS is even)            => create round MAX_ROUNDS
 */
export function computeSnapshotRoundForTransition(
  prevStatus: FilingStatus,
  nextStatus: FilingStatus
): number | null {
  // last even -> final  (only if MAX_ROUNDS is even)
  if (isFinal(nextStatus)) {
    return MAX_ROUNDS % 2 === 0 ? MAX_ROUNDS : null;
  }

  // draft -> v1_submitted
  if (prevStatus === 'draft' && isSubmittedStatus(nextStatus) && submittedIndex(nextStatus) === 1) {
    return 1;
  }

  // even -> odd (e.g., v2_submitted -> v3_submitted)
  if (isSubmittedStatus(prevStatus) && isSubmittedStatus(nextStatus)) {
    const p = submittedIndex(prevStatus);
    const n = submittedIndex(nextStatus);
    if (p % 2 === 0 && n % 2 === 1) return n;
  }

  return null;
}
