// path: src/api/filing/routes/filing.filing-status-change.ts
/**
 * Filing status change action routes (no free-form updates).
 * - POST /filings/:id/submit   -> filing.submit   (client → next auditor review stage)
 * - POST /filings/:id/advance  -> filing.advance  (auditor → next client edit stage)
 * - POST /filings/:id/finalize -> filing.finalize (auditor → final)
 */
export default {
  routes: [
    {
      method: 'POST',
      path: '/filings/:id/submit',
      handler: 'filing.submit',
      config: { policies: ['api::filing.require-project-membership'], middlewares: [] },
    },
    {
      method: 'POST',
      path: '/filings/:id/advance',
      handler: 'filing.advance',
      config: { policies: ['api::filing.require-project-membership'], middlewares: [] },
    },
    {
      method: 'POST',
      path: '/filings/:id/finalize',
      handler: 'filing.finalize',
      config: { policies: ['api::filing.require-project-membership'], middlewares: [] },
    },
  ],
};
