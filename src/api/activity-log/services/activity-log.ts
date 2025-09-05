import { factories } from '@strapi/strapi';

type AppendArgs = {
  action: 'edit' | 'score' | 'submit' | 'override' | 'lock';
  entityType: string;
  entityId: string;
  beforeJson?: any;
  afterJson?: any;
  userId?: number | null;
};

export default factories.createCoreService('api::activity-log.activity-log', ({ strapi }) => ({
  /**
   * Best-effort append; never throws upstream.
   */
  async append(args: AppendArgs) {
    const { action, entityType, entityId, beforeJson, afterJson, userId } = args;

    try {
      await strapi.documents('api::activity-log.activity-log').create({
        data: {
          action,
          entityType,
          entityId,
          beforeJson: beforeJson ?? null,
          afterJson: afterJson ?? null,
          users_permissions_user: userId
            ? { connect: [{ id: Number(userId) }] }
            : undefined,
        },
        status: 'published',
      } as any);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[activity-log.append] failed:', err);
      }
    }
  },
}));
