// path: src/api/client-document/policies/require-project-membership.ts
import { errors } from '@strapi/utils';
const { ForbiddenError, UnauthorizedError, NotFoundError, ValidationError } = errors;

type ActorRole = 'admin' | 'auditor' | 'authenticated';
const roleOf = (pc: any): ActorRole => {
  const raw = String(pc.state?.user?.role?.name ?? '').toLowerCase();
  if (raw === 'admin' || raw === 'administrator') return 'admin';
  if (raw === 'auditor') return 'auditor';
  return 'authenticated';
};

export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) throw new UnauthorizedError('Login required');

  const role = roleOf(policyContext);
  if (role === 'admin' || role === 'auditor') return true;

  const documentId = String(policyContext.params?.id ?? '').trim();
  if (!documentId) throw new ValidationError('Missing client-document id');

  const entry = await strapi.service('api::client-document.client-document').findOne(documentId, {
    fields: ['id'],
    populate: {
      filing: {
        fields: ['id'],
        populate: {
          project: {
            fields: ['id'],
            populate: { users_permissions_users: { fields: ['id'] } },
          },
        },
      },
    },
  } as any);

  if (!entry) throw new NotFoundError('ClientDocument not found');

  const members = entry?.filing?.project?.users_permissions_users ?? [];
  const isMember = members.some((u: any) => Number(u?.id) === Number(user.id));
  if (!isMember) throw new ForbiddenError('Not a member of this project');

  return true;
};
