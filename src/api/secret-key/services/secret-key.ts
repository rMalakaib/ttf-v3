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

const toHash = (maybeSecretOrHash?: string): string => {
  const s = (maybeSecretOrHash ?? "").trim();
  const isHex64 = /^[0-9a-f]{64}$/i.test(s);
  if (!s) {
    // generate secret, but never expose it; only return its hash
    const secret = crypto.randomBytes(32).toString("base64url");
    return crypto.createHash("sha256").update(secret).digest("hex");
  }
  return isHex64 ? s : crypto.createHash("sha256").update(s).digest("hex");
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
      fields: ['id', 'valueHash','keyState', 'revokedAt', 'expiresAt', 'createdAt', 'updatedAt'],
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
// or using the provided valueHash/plaintext secret (always stored/emitted as hash).
async rotateForProject(projectId: string, valueHashOrSecret?: string, ttlMinutes?: number) {
  const project = await this.ensureProject(projectId);
  if (!project) throw new NotFoundError('Project not found');

  // Revoke expired, then revoke all current actives (ensures only one active key exists)
  await this.revokeExpiredForProject(projectId);

  // IMPORTANT: omit `fields` so we get `documentId` back for updates
  const actives = await strapi.documents('api::secret-key.secret-key').findMany({
    filters: { project: { documentId: projectId }, keyState: 'active' },
    populate: [],
  });

  const hash = toHash(valueHashOrSecret);
  const ttl = Math.max(1, Number(ttlMinutes ?? TTL_MINUTES));
  const expires = expiresAtISO(ttl);

  const newKey = await strapi.documents('api::secret-key.secret-key').create({
    data: { valueHash: hash, keyState: 'active', expiresAt: expires, project: projectId },
  });

  const secretId = newKey.documentId;

  // Emit only hashed value; never the plaintext
  // channel/topic stays project-scoped; event key now uses the SECRET id
  strapi.service('api::realtime-sse.pubsub').publish(
    `project:${projectId}`,
    `project:secret-key:rotated:${secretId}`,
    'project:secret-key:rotated',
    {
      secretId,            // the secret's documentId (requested)
      projectId,           // still useful for clients
      valueHash: hash,
      expiresAt: expires,
      at: new Date().toISOString(),
    }
  );

  // Return only non-sensitive data + hash
  return {
    id: secretId,
    projectId,
    valueHash: hash,
    keyState: newKey.keyState,
    revokedAt: (newKey as any).revokedAt ?? null,
    expiresAt: (newKey as any).expiresAt ?? expires,
    createdAt: (newKey as any).createdAt,
    updatedAt: (newKey as any).updatedAt,
  };
}



}));
