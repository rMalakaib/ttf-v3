// path: src/api/secret-key/routes/secret-key.rotation-and-listing.ts
export default {
  routes: [
    /**
     * Rotate the project's current secret key:
     * Issues a new key, immediately invalidates the previous current key.
     */
    {
      method: 'POST',
      path: '/projects/:projectId/secret-keys/rotate',
      handler: 'secret-key.rotateKey',
      config: {
        policies: [
          // e.g., 'global::require-client-membership',
          // e.g., 'global::require-project-admin',
        ],
        middlewares: [],
      },
    },

    /**
     * Revoke a specific key by id for the given project (explicit audit action).
     */
    {
      method: 'POST', // or PATCH if you prefer partial updates
      path: '/projects/:projectId/secret-keys/:id/revoke',
      handler: 'secret-key.revokeKey',
      config: {
        policies: [
          // e.g., 'global::require-client-membership',
          // e.g., 'global::require-project-admin',
        ],
        middlewares: [],
      },
    },

    /**
     * List all keys (Active + Revoked) for a project.
     */
    {
      method: 'GET',
      path: '/projects/:projectId/secret-keys',
      handler: 'secret-key.listAll',
      config: {
        policies: [
          // e.g., 'global::require-client-membership',
          // or if auditors have read access: 'global::allow-auditor-or-project-member'
        ],
        middlewares: [],
      },
    },

    /**
     * List only Active keys for a project.
     */
    {
      method: 'GET',
      path: '/projects/:projectId/secret-keys/active',
      handler: 'secret-key.listActive',
      config: {
        policies: [
          // e.g., 'global::require-client-membership',
          // or 'global::allow-auditor-or-project-member'
        ],
        middlewares: [],
      },
    },
  ],
};
