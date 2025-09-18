// config/server.ts
const cronTasks = require('./cron-tasks');

export default ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  url: env('PUBLIC_URL', ''),     // e.g. https://<your-app>.strapiapp.com
  proxy: true,                    // trust x-forwarded-* from Cloud
  app: { keys: env.array('APP_KEYS') },
  cron: { enabled: env.bool('ENABLE_CRON', true), tasks: cronTasks },
});
