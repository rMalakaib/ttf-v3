// path: src/api/client-document/routes/client-document-files.ts
export default {
  routes: [
    {
      method: 'DELETE',
      path: '/client-documents/:id/files/:ids', // :ids = "12" or "12,34,56"
      handler: 'client-document.deleteFiles',
      config: { policies: ['api::client-document.require-project-membership'], middlewares: [] },
    },
  ],
};