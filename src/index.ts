// src/index.ts
import type { Core } from '@strapi/strapi';

const CREATE_CONCURRENTLY = `
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_one_published_draft_per_filing_question
ON answer_revisions (
  (model_prompt_raw->'meta'->>'filingId'),
  (model_prompt_raw->'meta'->>'questionId')
)
WHERE is_draft IS TRUE
  AND published_at IS NOT NULL
  AND (model_prompt_raw->'meta'->>'filingId')   IS NOT NULL
  AND (model_prompt_raw->'meta'->>'questionId') IS NOT NULL;`;

const CREATE_PLAIN = CREATE_CONCURRENTLY.replace(' CONCURRENTLY', '');

export default {
  register() {},
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    try {
      await strapi.db.connection.raw(CREATE_CONCURRENTLY);
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('cannot run CREATE INDEX CONCURRENTLY inside a transaction block')) {
        await strapi.db.connection.raw(CREATE_PLAIN);
      } else if (!msg.includes('already exists')) {
        throw e;
      }
    }
  },
};
