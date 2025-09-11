// // src/api/realtime-sse/services/activity-log.ts
// type LogCommon = { entityId: string; userId?: number | null };

// const userRel = (userId?: number | null) =>
//   userId ? { users_permissions_user: { connect: [userId] } } : {};

// export default ({ strapi }) => ({
//   async logSubscribe({ entityId, topics, userId }: LogCommon & { topics: string[] }) {
//     await strapi.documents('api::activity-log.activity-log').create({
//       status: 'published',
//       data: {
//         action: 'sse_subscribe',
//         entityType: 'sse',
//         entityId,
//         afterJson: { topics, userId },
//         ...userRel(userId),
//       },
//     });
//   },

//   async logPublish({
//     entityId,
//     event,
//     publishedCount,
//   }: LogCommon & { event: string; publishedCount: number }) {
//     await strapi.documents('api::activity-log.activity-log').create({
//       status: 'published',
//       data: {
//         action: 'sse_publish',
//         entityType: 'sse',
//         entityId,
//         afterJson: { event, publishedCount, at: new Date().toISOString() },
//       },
//     });
//   },

//   async logDisconnect({ entityId, durationMs, userId }: LogCommon & { durationMs: number }) {
//     await strapi.documents('api::activity-log.activity-log').create({
//       status: 'published',
//       data: {
//         action: 'sse_disconnect',
//         entityType: 'sse',
//         entityId,
//         afterJson: { durationMs },
//         ...userRel(userId),
//       },
//     });
//   },
// });
