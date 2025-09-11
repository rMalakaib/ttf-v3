// src/api/realtime-sse/routes/realtime-sse.ts
export default {
  routes: [
    {
      method: 'GET',
      path: '/realtime-sse/stream',
      handler: 'realtime-sse.stream',
      config: { policies: [] },
    },

    {
      method: 'POST',
      path: '/realtime-sse/subscriptions/:id/unsubscribe',
      handler: 'realtime-sse.unsubscribe',
      config: {}, // or your auth policy
    },

    {
      method: 'POST',
      path: '/realtime-sse/subscriptions/:id/subscribe',
      handler: 'realtime-sse.subscribe',
      config: {
        policies: [],                  // or reuse your guard policy if you wired one
        middlewares: [],
      },
    },
  ],
};
// /realtime-sse/stream?projectId=P&filingId=F&questionId=Q&answerRevisionId=