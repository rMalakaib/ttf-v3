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
      {
    method: "GET",
    path: "/realtime-sse/smoke",
    handler: "smoke.test",
    config: {
      // default is authenticated; set auth:false to make it public if desired
      // auth: false,
      policies: [],
    },
  },

  ],
};
// /realtime-sse/stream?projectId=P&filingId=F&questionId=Q&answerRevisionId=