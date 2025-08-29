// src/api/secret-key/services/secret-key.ts
import { factories } from '@strapi/strapi';
import crypto from 'node:crypto';

class NotFoundError extends Error { code = 'NOT_FOUND' as const; }
class ForbiddenError extends Error { code = 'FORBIDDEN' as const; }

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

  // Minimal existence check — no more 'secret_key' populate
  async ensureProject(projectId: string) {
    return strapi.documents('api::project.project').findOne({
      documentId: projectId, fields: ['id'], populate: [],
    });
  },

  // If key is expired and still active, revoke it
  async revokeIfExpired(keyId: string) {
    const key = await strapi.documents('api::secret-key.secret-key').findOne({
      documentId: keyId,
      fields: ['id', 'keyState', 'revokedAt', 'expiresAt'],
      populate: ['project'],
    });
    if (!key) return;

    const exp = (key as any).expiresAt ? new Date((key as any).expiresAt) : null;
    if (!exp || key.keyState === 'revoked' || exp.getTime() > Date.now()) return;

    await strapi.documents('api::secret-key.secret-key').update({
      documentId: keyId, data: { keyState: 'revoked', revokedAt: nowISO() },
    });
  },

  // Revoke all expired active keys for this project (idempotent)
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

    return {
      id: updated.documentId,
      keyState: updated.keyState,
      revokedAt: (updated as any).revokedAt ?? null,
      expiresAt: (updated as any).expiresAt ?? null,
      createdAt: (updated as any).createdAt,
      updatedAt: (updated as any).updatedAt,
    };
  },

  // Rotate by revoking ANY existing active keys for the project, then creating one fresh active key
  async rotateForProject(projectId: string, valueHash?: string, ttlMinutes?: number) {
    const project = await this.ensureProject(projectId);
    if (!project) throw new NotFoundError('Project not found');

    // Revoke expired, then revoke all current actives (ensures only one active key exists)
    await this.revokeExpiredForProject(projectId);
    const actives = await strapi.documents('api::secret-key.secret-key').findMany({
      filters: { project: { documentId: projectId }, keyState: 'active' },
      fields: ['id'], populate: [],
    });
    if (actives.length) {
      await Promise.all(
        actives.map(k =>
          strapi.documents('api::secret-key.secret-key').update({
            documentId: k.documentId as string,
            data: { keyState: 'revoked', revokedAt: nowISO() },
          }),
        ),
      );
    }

    let secret: string | undefined;
    let hash = valueHash?.trim();
    if (!hash) { const g = generateSecretAndHash(); secret = g.secret; hash = g.valueHash; }

    const ttl = Math.max(1, Number(ttlMinutes ?? TTL_MINUTES));
    const expires = expiresAtISO(ttl);

    const newKey = await strapi.documents('api::secret-key.secret-key').create({
      data: { valueHash: hash, keyState: 'active', expiresAt: expires, project: projectId },
    });

    const payload: any = {
      id: newKey.documentId,
      keyState: newKey.keyState,
      revokedAt: (newKey as any).revokedAt ?? null,
      expiresAt: (newKey as any).expiresAt ?? expires,
      createdAt: (newKey as any).createdAt,
      updatedAt: (newKey as any).updatedAt,
    };
    if (secret) payload.secret = secret; // only when server generated it
    return payload;
  },

}));
