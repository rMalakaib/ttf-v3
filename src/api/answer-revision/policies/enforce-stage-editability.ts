// path: src/api/answer-revision/policies/enforce-stage-editability.ts
// Step 5 (tightened) — only `answerText` is client-editable
import { isAuditorReviewStage, isClientEditStage, type FilingStatus } from '../../filing/utils/status';

type ActorRole = 'Authenticated' | 'auditor' | 'admin';

function deriveActorRole(user: any): ActorRole {
  const raw = (user?.role?.name ?? '').toString().trim().toLowerCase();
  if (raw === 'admin' || raw === 'administrator') return 'admin';
  if (raw === 'auditor') return 'auditor';
  return 'Authenticated';
}

async function log(strapi: any, opts: {
  allow: boolean; entityId: string; userId?: number | string | null; payload?: any; meta: Record<string, any>;
}) {
  try {
    await strapi.documents('api::activity-log.activity-log').create({
      data: {
        action: opts.allow ? 'edit' : 'lock',
        entityType: 'answer-revision.policy',
        entityId: String(opts.entityId),
        beforeJson: opts.meta,
        afterJson: opts.payload ?? null,
        ...(opts.userId ? { users_permissions_user: { id: opts.userId } } : {}),
      },
      status: 'published',
    } as any);
  } catch {}
}

// ⬇️ Only allow this single client-editable field
const CLIENT_FIELDS  = new Set(['answerText']);
const AUDITOR_FIELDS = new Set(['auditorScore','auditorReason','auditorSuggestion']);
const IGNORED_FIELDS = new Set(['filing','question','users_permissions_user','submission_answers','revisionIndex','isDraft']);

export default async (policyContext: any, _config: unknown, { strapi }: { strapi: any }) => {
  const method = String(policyContext.request?.method ?? policyContext.request?.ctx?.method ?? '').toUpperCase();
  if (!['POST','PUT','PATCH','DELETE'].includes(method)) return true;

  const user   = policyContext.state?.user;
  const role   = deriveActorRole(user);
  const userId = user?.id ?? null;

  const raw = policyContext.request?.body ?? {};
  const payload = (raw && typeof raw === 'object' && 'data' in raw) ? (raw as any).data : raw;

  // ---------- CREATE (client drafts only; require answerText)
  if (method === 'POST') {
    const filingRel = payload?.filing;
    const filingDocumentId = filingRel?.documentId ?? filingRel;
    if (!filingDocumentId) {
      await log(strapi, { allow:false, entityId:'new', userId, payload,
        meta:{ step:5, reason:'AnswerRevision.create requires filing.documentId', role, method, url: policyContext.request?.url ?? '' }});
      return { status:400, message:'AnswerRevision.create requires filing.documentId' };
    }

    // load filing status
    const filing = await strapi.documents('api::filing.filing').findOne({
      documentId: filingDocumentId,
      fields: ['filingStatus'] as any,
      populate: [],
    } as any);
    const status = filing?.filingStatus as FilingStatus | undefined;

    // treat draft + client-edit stages as client-owned
    const isClientStage = status === 'draft' || (status && isClientEditStage(status));
    if (!isClientStage) {
      await log(strapi, { allow:false, entityId:'new', userId, payload,
        meta:{ step:5, reason:'Create allowed only during client stages', role, method, status }});
      return { status:403, message:'Create allowed only during client stages' };
    }

    // only clients/admin can create
    if (!(role === 'Authenticated' || role === 'admin')) {
      await log(strapi, { allow:false, entityId:'new', userId, payload,
        meta:{ step:5, reason:'Only clients may create drafts', role, method, status }});
      return { status:403, message:'Only clients may create drafts' };
    }

    // must be a draft
    if (payload?.isDraft === false) {
      await log(strapi, { allow:false, entityId:'new', userId, payload,
        meta:{ step:5, reason:'Cannot create snapshot AnswerRevisions', role, method, status }});
      return { status:403, message:'Cannot create snapshot AnswerRevisions' };
    }

    // ✅ enforce `answerText` only (and present)
    const fieldsChanged = Object.keys(payload || {}).filter((k) => !IGNORED_FIELDS.has(k));
    if (!('answerText' in (payload || {})) || String(payload.answerText ?? '').trim() === '') {
      await log(strapi, { allow:false, entityId:'new', userId, payload,
        meta:{ step:5, reason:'answerText is required on create', role, method, status, fieldsChanged }});
      return { status:400, message:'answerText is required on create' };
    }
    if (fieldsChanged.some((f) => !CLIENT_FIELDS.has(f))) {
      await log(strapi, { allow:false, entityId:'new', userId, payload,
        meta:{ step:5, reason:`Only answerText allowed on create: ${fieldsChanged.join(', ')}`, role, method, status, fieldsChanged }});
      return { status:403, message:`Only answerText allowed on create: ${fieldsChanged.join(', ')}` };
    }

    await log(strapi, { allow:true, entityId:'new', userId, payload,
      meta:{ step:5, role, method, status, fieldsChanged }});
    return true;
  }

  // ---------- UPDATE / DELETE
  const documentId = policyContext.params?.id ?? 'unknown';
  let status: FilingStatus | undefined;
  let isDraft: boolean | undefined;

  if (documentId !== 'unknown') {
    const rev = await strapi.documents('api::answer-revision.answer-revision').findOne({
      documentId,
      fields: ['isDraft'] as any,
      populate: { filing: { fields: ['filingStatus'] as any } } as any,
    } as any);
    status  = rev?.filing?.filingStatus as FilingStatus | undefined;
    isDraft = !!rev?.isDraft;
  }

  const fieldsChanged = Object.keys(payload || {}).filter((k) => !IGNORED_FIELDS.has(k));

  // Auditor-review stages → auditors/admin → snapshots → auditor fields only
  if (status && isAuditorReviewStage(status)) {
    if (!(role === 'auditor' || role === 'admin')) {
      await log(strapi, { allow:false, entityId:documentId, userId, payload,
        meta:{ step:5, reason:'Only auditors may update during auditor-review stages', role, method, status, isDraft, fieldsChanged }});
      return { status:403, message:'Only auditors may update during auditor-review stages' };
    }
    if (isDraft) {
      await log(strapi, { allow:false, entityId:documentId, userId, payload,
        meta:{ step:5, reason:'Only snapshots can be edited during auditor-review stages', role, method, status, isDraft, fieldsChanged }});
      return { status:403, message:'Only snapshots can be edited during auditor-review stages' };
    }
    if (method === 'DELETE') {
      await log(strapi, { allow:false, entityId:documentId, userId, payload,
        meta:{ step:5, reason:'Snapshots cannot be deleted during auditor-review stages', role, method, status, isDraft, fieldsChanged }});
      return { status:403, message:'Snapshots cannot be deleted during auditor-review stages' };
    }
    if (fieldsChanged.length && fieldsChanged.some((f) => !AUDITOR_FIELDS.has(f))) {
      await log(strapi, { allow:false, entityId:documentId, userId, payload,
        meta:{ step:5, reason:`Only auditor fields allowed on snapshots: ${fieldsChanged.join(', ')}`, role, method, status, isDraft, fieldsChanged }});
      return { status:403, message:`Only auditor fields allowed on snapshots: ${fieldsChanged.join(', ')}` };
    }
    await log(strapi, { allow:true, entityId:documentId, userId, payload,
      meta:{ step:5, role, method, status, isDraft:false, fieldsChanged }});
    return true;
  }

  // Client-owned stages (incl. draft) → clients/admin → drafts → ONLY answerText
  const isClientStage = status === 'draft' || (status && isClientEditStage(status));
  if (isClientStage) {
    if (!(role === 'Authenticated' || role === 'admin')) {
      await log(strapi, { allow:false, entityId:documentId, userId, payload,
        meta:{ step:5, reason:'Only clients may update during client-edit/draft stages', role, method, status, isDraft, fieldsChanged }});
      return { status:403, message:'Only clients may update during client-edit/draft stages' };
    }
    if (!isDraft) {
      await log(strapi, { allow:false, entityId:documentId, userId, payload,
        meta:{ step:5, reason:'Only drafts can be edited during client-edit/draft stages', role, method, status, isDraft, fieldsChanged }});
      return { status:403, message:'Only drafts can be edited during client-edit/draft stages' };
    }
    if (fieldsChanged.length && fieldsChanged.some((f) => AUDITOR_FIELDS.has(f))) {
      await log(strapi, { allow:false, entityId:documentId, userId, payload,
        meta:{ step:5, reason:`Auditor fields cannot be edited during client-edit/draft stages: ${fieldsChanged.join(', ')}`, role, method, status, isDraft, fieldsChanged }});
      return { status:403, message:`Auditor fields cannot be edited during client-edit/draft stages: ${fieldsChanged.join(', ')}` };
    }
    if (fieldsChanged.length && fieldsChanged.some((f) => !CLIENT_FIELDS.has(f))) {
      await log(strapi, { allow:false, entityId:documentId, userId, payload,
        meta:{ step:5, reason:`Only answerText may be edited on drafts: ${fieldsChanged.join(', ')}`, role, method, status, isDraft, fieldsChanged }});
      return { status:403, message:`Only answerText may be edited on drafts: ${fieldsChanged.join(', ')}` };
    }
    await log(strapi, { allow:true, entityId:documentId, userId, payload,
      meta:{ step:5, role, method, status, isDraft:true, fieldsChanged }});
    return true;
  }

  await log(strapi, { allow:false, entityId:documentId, userId, payload,
    meta:{ step:5, reason:'deny-writes (final/unknown stage)', role, method, status, isDraft, fieldsChanged }});
  return { status:403, message:'Stage editability (step 5): writes disabled (final/unknown stage)' };
};
