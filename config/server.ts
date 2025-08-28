// config/server.ts
// import cronTasks = require("./cron");

const cronTasks = require("./cron-tasks");

export default ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  app: { keys: env.array('APP_KEYS') },
  cron: { enabled: env.bool('ENABLE_CRON', true), tasks: cronTasks },
});
