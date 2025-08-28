// src/api/secret-key/services/secret-key.ts
import { factories } from '@strapi/strapi';
import crypto from 'node:crypto';

class NotFoundError extends Error { code = 'NOT_FOUND' as const; }
class ForbiddenError extends Error { code = 'FORBIDDEN' as const; }

// One source of truth (same env var as cron)
const TTL_MINUTES = Math.max(1, Number(process.env.SECRET_KEY_TTL_MINUTES ?? 15));

const nowISO = () => new Date().toISOString();
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const expiresAtISO = (ttl: number = TTL_MINUTES) => addMinutes(new Date(), ttl).toISOString();

const generateSecretAndHash = () => {
  const secret = crypto.randomBytes(32).toString('base64url');
  const valueHash = crypto.createHash('sha256').update(secret).digest('hex');
  return { secret, valueHash };
};

export default factories.createCoreService('api::secret-key.secret-key', ({ strapi }) => ({

  async ensureProject(projectId: string, withCurrent = false) {
    return strapi.documents('api::project.project').findOne({
      documentId: projectId, fields: ['id'], populate: withCurrent ? ['secret_key'] : [],
    });
  },

  async revokeIfExpired(keyId: string) {
    const key = await strapi.documents('api::secret-key.secret-key').findOne({
      documentId: keyId, fields: ['id', 'keyState', 'revokedAt', 'expiresAt'], populate: ['project'],
    });
    if (!key) return;

    const exp = (key as any).expiresAt ? new Date((key as any).expiresAt) : null;
    if (!exp || key.keyState === 'revoked' || exp.getTime() > Date.now()) return;

    const updated = await strapi.documents('api::secret-key.secret-key').update({
      documentId: keyId, data: { keyState: 'revoked', revokedAt: nowISO() },
    });

    const projectId = (key.project as any)?.documentId as string | undefined;
    if (projectId) {
      const proj = await this.ensureProject(projectId, true);
      if (proj?.secret_key && (proj.secret_key as any).documentId === updated.documentId) {
        await strapi.documents('api::project.project').update({
          documentId: projectId, data: { secret_key: null },
        });
      }
    }
  },

  async revokeExpiredForProject(projectId: string) {
    const now = nowISO();
    const expiredActives = await strapi.documents('api::secret-key.secret-key').findMany({
      filters: { project: { documentId: projectId }, keyState: 'active', expiresAt: { $lte: now } },
      fields: ['id'], populate: [], sort: ['createdAt:desc'],
    });
    if (!expiredActives.length) return [] as string[];
    await Promise.all(expiredActives.map(k => this.revokeIfExpired(k.documentId as string)));
    return expiredActives.map(k => k.documentId as string);
  },

  async listAll(projectId: string) {
    await this.revokeExpiredForProject(projectId);
    return strapi.documents('api::secret-key.secret-key').findMany({
      filters: { project: { documentId: projectId } },
      sort: ['createdAt:desc'],
      fields: ['id', 'keyState', 'revokedAt', 'expiresAt', 'createdAt', 'updatedAt'],
      populate: [],
    });
  },

  async listActive(projectId: string) {
    await this.revokeExpiredForProject(projectId);
    return strapi.documents('api::secret-key.secret-key').findMany({
      filters: { project: { documentId: projectId }, keyState: 'active' },
      sort: ['createdAt:desc'],
      fields: ['id', 'keyState', 'revokedAt', 'expiresAt', 'createdAt', 'updatedAt'],
      populate: [],
    });
  },

  async revokeForProject(projectId: string, keyId: string) {
    await this.revokeExpiredForProject(projectId);

    const key = await strapi.documents('api::secret-key.secret-key').findOne({
      documentId: keyId, fields: ['id', 'keyState', 'revokedAt', 'expiresAt'], populate: ['project'],
    });
    if (!key) throw new NotFoundError('Secret key not found');

    const belongs = key.project && (key.project as any).documentId === projectId;
    if (!belongs) throw new ForbiddenError('Key does not belong to this project');

    const updated = key.keyState === 'revoked'
      ? key
      : await strapi.documents('api::secret-key.secret-key').update({
          documentId: keyId, data: { keyState: 'revoked', revokedAt: nowISO() },
        });

    const proj = await this.ensureProject(projectId, true);
    if (proj?.secret_key && (proj.secret_key as any).documentId === updated.documentId) {
      await strapi.documents('api::project.project').update({
        documentId: projectId, data: { secret_key: null },
      });
    }

    return {
      id: updated.documentId,
      keyState: updated.keyState,
      revokedAt: (updated as any).revokedAt ?? null,
      expiresAt: (updated as any).expiresAt ?? null,
      createdAt: (updated as any).createdAt,
      updatedAt: (updated as any).updatedAt,
    };
  },

  async rotateForProject(projectId: string, valueHash?: string, ttlMinutes?: number) {
    const project = await this.ensureProject(projectId, true);
    if (!project) throw new NotFoundError('Project not found');

    await this.revokeExpiredForProject(projectId);

    if (project.secret_key) {
      const currentId = (project.secret_key as any).documentId;
      await strapi.documents('api::secret-key.secret-key').update({
        documentId: currentId, data: { keyState: 'revoked', revokedAt: nowISO() },
      });
    }

    let secret: string | undefined;
    let hash = valueHash?.trim();
    if (!hash) { const g = generateSecretAndHash(); secret = g.secret; hash = g.valueHash; }

    const ttl = Math.max(1, Number(ttlMinutes ?? TTL_MINUTES));
    const expires = expiresAtISO(ttl);

    const newKey = await strapi.documents('api::secret-key.secret-key').create({
      data: { valueHash: hash, keyState: 'active', expiresAt: expires, project: projectId },
    });

    await strapi.documents('api::project.project').update({
      documentId: projectId, data: { secret_key: newKey.documentId },
    });

    const payload: any = {
      id: newKey.documentId,
      keyState: newKey.keyState,
      revokedAt: (newKey as any).revokedAt ?? null,
      expiresAt: (newKey as any).expiresAt ?? expires,
      createdAt: (newKey as any).createdAt,
      updatedAt: (newKey as any).updatedAt,
    };
    if (secret) payload.secret = secret;
    return payload;
  },

}));
