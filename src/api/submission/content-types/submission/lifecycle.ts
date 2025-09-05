// Immutability: once created, the link tuple (submission, question, answer_revision) can't change.
export default {
  async beforeUpdate(event: any) {
    const data = event?.params?.data || {};
    const BLOCK = new Set(['submission', 'question', 'answer_revision']);

    for (const k of Object.keys(data)) {
      if (BLOCK.has(k)) {
        throw new Error(`Field "${k}" cannot be changed after creation`);
      }
    }
  },
};
