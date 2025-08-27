// ./config/plugins.ts
export default {
  'users-permissions': {
    config: {
      register: {
        // allow custom fields during /auth/local/register
        allowedFields: ['telegramHandle'], // add whatever you need
      },
    },
  },
};
