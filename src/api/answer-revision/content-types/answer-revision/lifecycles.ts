export default {
  
    async beforeUpdate(event: any) {
        const data = event.params?.data ?? {};
        if (!data || typeof data !== 'object') return;

        // Allow auditors to clear these three fields with null or "" (or omit → unchanged)
        if ('auditorReason' in data && (data.auditorReason === '' || data.auditorReason === undefined)) {
        data.auditorReason = null;
        }
        if ('auditorSuggestion' in data && (data.auditorSuggestion === '' || data.auditorSuggestion === undefined)) {
        data.auditorSuggestion = null;
        }
        if ('auditorScore' in data) {
        const v = data.auditorScore;
        if (v === '' || v === undefined) {
            data.auditorScore = null;
        } else if (v === null) {
            data.auditorScore = null;
        } else {
            const num = typeof v === 'string' ? Number(v) : Number(v);
            data.auditorScore = Number.isFinite(num) ? num : null;
        }
        }
    },
  
    async afterUpdate(event: any) {
    const data   = event.params?.data ?? {};
    const result = event.result ?? {};

    // Only when an auditor edits a SNAPSHOT (isDraft:false) and touched auditorScore
    const isSnapshot = result?.isDraft === false;
    const auditorScoreTouched = Object.prototype.hasOwnProperty.call(data, 'auditorScore');

    if (!isSnapshot || !auditorScoreTouched) return;

    const userId = data?.users_permissions_user?.id ?? data?.users_permissions_user ?? null;

    // Call the service helper you just added
    await strapi
      .service('api::answer-revision.answer-revision')
      .recomputeLinkedSubmissionScores({
        revisionDocumentId: result.documentId,
        userId,
      });
  },
};
