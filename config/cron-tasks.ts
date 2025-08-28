// Run: cleanup of expired secret keys
// Uses the same TTL env var as your service: SECRET_KEY_TTL_MINUTES
// Optional: SECRET_KEY_CRON_RULE (overrides schedule), CRON_TZ

const LOCK_KEY = 42112202; // Postgres advisory lock key (prevents duplicate work across replicas)

// One source of truth for timing
const TTL_MIN = Math.max(1, Number(process.env.SECRET_KEY_TTL_MINUTES ?? 15));
// If no explicit rule is set, run ~3x per key lifetime (clamped between 1 and 30 minutes)
const STEP_MIN = Math.max(1, Math.min(30, Math.floor(TTL_MIN / 3) || 1));
const RULE = process.env.SECRET_KEY_CRON_RULE || `*/${STEP_MIN} * * * *`;

module.exports = {
  revokeSecretKeys: {
    task: async ({ strapi }) => {
      const startedAt = new Date();
      const nowISO = startedAt.toISOString();
      console.log('[cron:revokeSecretKeys] start', { startedAt: nowISO, TTL_MIN, RULE, TZ: process.env.CRON_TZ || 'server-default' });

      // Optional cross-instance lock (Postgres)
      const knex = strapi.db?.connection;
      let haveLock = false;

      try {
        if (knex?.client?.config?.client?.includes('pg')) {
          const res = await knex.raw('SELECT pg_try_advisory_lock(?) AS locked', [LOCK_KEY]);
          const row = res?.rows?.[0] ?? res?.[0];
          haveLock = !!(row?.locked ?? row?.pg_try_advisory_lock);
          if (!haveLock) {
            console.log('[cron:revokeSecretKeys] skip — another instance holds the lock');
            return;
          }
        }

        let page = 1;
        let revoked = 0;
        const pageSize = 100;

        while (true) {
          const batch = await strapi.documents('api::secret-key.secret-key').findMany({
            filters: { keyState: 'active', expiresAt: { $lte: nowISO } },
            fields: ['id'],
            populate: ['project'],
            pagination: { page, pageSize },
            sort: ['createdAt:desc'],
          });
          if (!batch.length) break;

          for (const key of batch) {
            try {
              await strapi.service('api::secret-key.secret-key').revokeIfExpired(key.documentId);
              revoked++;
            } catch (err) {
              console.error('[cron:revokeSecretKeys] revoke error', key.documentId, err);
            }
          }

          if (batch.length < pageSize) break;
          page++;
        }

        console.log('[cron:revokeSecretKeys] end', { finishedAt: new Date().toISOString(), revoked });
      } catch (err) {
        console.error('[cron:revokeSecretKeys] failed', err);
      } finally {
        if (haveLock && knex?.client?.config?.client?.includes('pg')) {
          try { await knex.raw('SELECT pg_advisory_unlock(?)', [LOCK_KEY]); } catch {}
        }
      }
    },

    options: {
      rule: RULE,                     // cron expression
      tz: process.env.CRON_TZ || 'UTC'
    },
  },
};
