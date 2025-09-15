// ./config/plugins.ts
// Minimal typing so TS knows what `env` is
type EnvFn = (key: string, defaultValue?: string) => string;

export default ({ env }: { env: EnvFn }) => ({
  // keep your existing users-permissions config
  'users-permissions': {
    config: {
      register: {
        // allow custom fields during /auth/local/register
        allowedFields: ['telegramHandle'],
      },
    },
  },

  // email plugin (Nodemailer over SMTP)
  email: {
    config: {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST', 'sandbox.smtp.mailtrap.io'),
        port: Number(env('SMTP_PORT', '2525')),
        auth: {
          user: env('SMTP_USER', ''),
          pass: env('SMTP_PASS', ''),
        },
      },
      settings: {
        defaultFrom: env('EMAIL_FROM', 'no-reply@localhost'),
        defaultReplyTo: env('EMAIL_REPLY_TO', 'no-reply@localhost'),
      },
    },
  },
});
