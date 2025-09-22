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

    strapi.log.info('\n [bootstrap] enforce one draft AnswerRevision per question per filing');

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

    /**
   * Registers a DB-level lifecycle subscriber for the Users & Permissions user model. On each update it records the user’s pre-update role, then after the write reloads the new role; if the transition is from "authenticated" to any other role, it publishes a single SSE event ("user:role:changed") to `user:{id}` with an ISO timestamp. DB lifecycles fire no matter how the user is updated (Admin UI, REST, or custom code), and logs confirm before/after role states. Requires the `api::realtime-sse.pubsub` service.
   */
    strapi.log.info('\n [bootstrap] registering DB lifecycles for users-permissions.user');

    strapi.db.lifecycles.subscribe({
      models: ['plugin::users-permissions.user'],

      async beforeUpdate(event) {
        const id = event?.params?.where?.id;
        if (!id) return;

        const prev = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { id },
          populate: { role: { select: ['type', 'name'] } },
        });

        event.state = event.state || {};
        event.state.prevRoleType = prev?.role?.type ?? null;

        
      },

      async afterUpdate(event) {
        const id = event?.params?.where?.id;
        if (!id) return;

        const next = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { id },
          populate: { role: { select: ['type', 'name'] } },
        });

        const prevRoleType = event?.state?.prevRoleType ?? null;
        const nextRoleType = next?.role?.type ?? null;

        

        // Only fire when moving FROM authenticated -> something else
        if (prevRoleType === 'authenticated' && nextRoleType && nextRoleType !== 'authenticated') {
          try {
            const pubsub = strapi.service('api::realtime-sse.pubsub');
            await pubsub.publish(
              `user:${id}`,
              `user:role:changed:${id}`,  // message id
              'user:role:changed',
              { userId: id, from: 'authenticated', to: nextRoleType, at: new Date().toISOString() }
            );
            
          } catch (e: any) {
            strapi.log.warn(`[role-lc] emit failed for user=${id}: ${e?.message || e}`);
          }
        }
      },
    });
  },
};
