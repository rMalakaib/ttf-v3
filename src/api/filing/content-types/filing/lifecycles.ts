// path: src/api/filing/content-types/filing/lifecycles.ts
/**
 * Filing lifecycles
 * - Step 8: Make firstSubmitAt / finalizedAt immutable once set.
 * - Step 10: Backstop monotonic status — block any non-monotonic change regardless of source.
 */
import {
  MAX_ROUNDS,
  isValidStatus,
  statusIndex,
  type FilingStatus,
} from '../../utils/status';

export default {
  async beforeCreate(event: any) {
    // Step 8: prevent callers from stamping these at creation time
    if (event?.params?.data) {
      delete event.params.data.firstSubmitAt;
      delete event.params.data.finalizedAt;
    }
  },

  async beforeUpdate(event: any) {
    const documentId = event?.params?.where?.documentId;
    if (!documentId) return;

    // Fetch current row (minimal fields needed for checks)
    const existing = await strapi.documents('api::filing.filing').findOne({
      documentId,
      fields: ['filingStatus', 'firstSubmitAt', 'finalizedAt'] as any,
      populate: [],
    } as any);
    if (!existing) return;

    const data = event?.params?.data || {};

    // -------- Step 10: Monotonic backstop on filingStatus --------
    if (Object.prototype.hasOwnProperty.call(data, 'filingStatus')) {
      const prev = existing.filingStatus as string;
      const next = data.filingStatus as string;

      // Allow no-op
      if (prev !== next) {
        // Validate both statuses
        if (!isValidStatus(prev, MAX_ROUNDS) || !isValidStatus(next, MAX_ROUNDS)) {
          throw new Error(`Invalid filing status transition: ${prev} → ${next}`);
        }

        if (prev === 'final') {
          throw new Error('Final is terminal; status cannot change after final.');
        }

        const prevIdx = statusIndex(prev as FilingStatus, MAX_ROUNDS);
        const nextIdx = statusIndex(next as FilingStatus, MAX_ROUNDS);

        // Enforce: next must be exactly one step ahead
        if (nextIdx !== prevIdx + 1) {
          const reason = nextIdx < prevIdx ? 'backward' : 'skip';
          throw new Error(`Non-monotonic status change (${reason}) disallowed: ${prev} → ${next}`);
        }
      }
    }

    // -------- Step 8: Immutable stamps (firstSubmitAt / finalizedAt) --------
    if (
      Object.prototype.hasOwnProperty.call(data, 'firstSubmitAt') &&
      existing.firstSubmitAt &&
      data.firstSubmitAt !== existing.firstSubmitAt
    ) {
      throw new Error('firstSubmitAt is immutable once set');
    }

    if (
      Object.prototype.hasOwnProperty.call(data, 'finalizedAt') &&
      existing.finalizedAt &&
      data.finalizedAt !== existing.finalizedAt
    ) {
      throw new Error('finalizedAt is immutable once set');
    }
  },
};
