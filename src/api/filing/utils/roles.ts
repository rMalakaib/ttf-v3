// path: src/api/filing/utils/roles.ts
/**
 * Role ownership & permissions per stage.
 * Pairs with status helpers in ./status.ts.
 */
import {
  MAX_ROUNDS,
  type FilingStatus,
  isAuditorReviewStage,
  isClientEditStage,
  nextStatus,
  isLastSubmittedRound,
} from './status';

export type ActorRole = 'client' | 'auditor' | 'admin'; // expand if you have more app roles
export type Action = 'submit' | 'advance' | 'finalize';

/** Stage typing */
export type StageKind = 'draft' | 'client-edit' | 'auditor-review' | 'final';

export function stageKind(status: FilingStatus): StageKind {
  if (status === 'draft') return 'draft';
  if (status === 'final') return 'final';
  if (isClientEditStage(status)) return 'client-edit';
  if (isAuditorReviewStage(status)) return 'auditor-review';
  // unreachable if FilingStatus is validated elsewhere
  return 'auditor-review';
}

/** Who may advance status at each stage, and how */
export function allowedActionsFor(
  status: FilingStatus,
  role: ActorRole,
  maxRounds: number = MAX_ROUNDS
): Action[] {
  const kind = stageKind(status);
  const isAdmin = role === 'admin';

  if (kind === 'draft') {
    return role === 'client' || isAdmin ? ['submit'] : [];
  }

  if (kind === 'client-edit') {
    // If we're at the LAST configured round:
    // - allow client/admin to SUBMIT (which transitions to 'final' via nextStatus)
    // - allow auditor/admin to FINALIZE (keeps existing auditor workflow)
    if (isLastSubmittedRound(status, maxRounds)) {
      const actions: Action[] = [];
      if (role === 'client' || isAdmin) actions.push('submit');
      // Auditor can not move from last even submission to final. The Authenticated user must. 
      if (role === 'auditor' || isAdmin) actions.push('finalize');
      return actions;
    }
    // Otherwise clients submit to the next auditor review stage.
    return role === 'client' || isAdmin ? ['submit'] : [];
  }

  if (kind === 'auditor-review') {
    // Auditor can not move from last even submission to final. The Authenticated user must. 
    if (role === 'auditor' || isAdmin) {
      const n = nextStatus(status, maxRounds);
      return n === 'final' ? ['finalize'] : ['advance'];
    }
    return [];
  }

  return []; // final
}

/** AnswerRevision field ownership by stage (documented, not enforced here) */
export const CLIENT_EDIT_FIELDS = ['answerText'] as const;
// Auditor can annotate submitted snapshots; do NOT allow changing client/model fields in review
export const AUDITOR_REVIEW_FIELDS = ['auditorScore', 'auditorReason', 'auditorSuggestion'] as const;

/**
 * Predicate you can call before write operations on AnswerRevision.
 * - `isSnapshot`: true when editing the immutable submitted snapshot for a version
 * - `isDraft`: true when editing the user's working draft for the next version
 */
export function canEditAnswerRevisionField(opts: {
  status: FilingStatus;
  role: ActorRole;
  field: string;
  isSnapshot: boolean;
  isDraft: boolean;
}): boolean {
  const kind = stageKind(opts.status);

  if (kind === 'client-edit') {
    // Clients edit their drafts only
    if (opts.role === 'client' && opts.isDraft) {
      return (CLIENT_EDIT_FIELDS as readonly string[]).includes(opts.field);
    }
    return false;
  }

  if (kind === 'auditor-review') {
    // Auditors annotate snapshots only
    if ((opts.role === 'auditor' || opts.role === 'admin') && opts.isSnapshot) {
      return (AUDITOR_REVIEW_FIELDS as readonly string[]).includes(opts.field);
    }
    return false;
  }

  // draft/final: restrict by your broader rules (usually: client can submit from draft; no edits in final)
  return false;
}
