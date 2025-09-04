// Custom QuestionLock routes — strict, TTL-based locks scoped to (filing, question).
// Exposes:
// POST /filings/:filingId/questions/:questionId/locks/acquire   -> question-lock.acquire
// POST /filings/:filingId/questions/:questionId/locks/heartbeat -> question-lock.heartbeat
// POST /filings/:filingId/questions/:questionId/locks/release   -> question-lock.release
// GET  /filings/:filingId/questions/:questionId/locks/status    -> question-lock.status

export default {
  routes: [
    {
      method: 'POST',
      path: '/filings/:filingId/questions/:questionId/locks/acquire',
      handler: 'question-lock.acquire',
      config: {
        // Only members/auditor/admin can acquire/renew a lock
        policies: [{ name: 'global::enforce-project-membership', config: { target: 'answer-revision' } }],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/filings/:filingId/questions/:questionId/locks/heartbeat',
      handler: 'question-lock.heartbeat',
      config: {
        policies: [{ name: 'global::enforce-project-membership', config: { target: 'answer-revision' } }],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/filings/:filingId/questions/:questionId/locks/release',
      handler: 'question-lock.release',
      config: {
        policies: [{ name: 'global::enforce-project-membership', config: { target: 'answer-revision' } }],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/filings/:filingId/questions/:questionId/locks/status',
      handler: 'question-lock.status',
      config: {
        // Reads are open per your requirement (no read policy)
        policies: [],
        middlewares: [],
      },
    },
  ],
};
