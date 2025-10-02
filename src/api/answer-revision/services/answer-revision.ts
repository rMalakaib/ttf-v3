// path: src/api/answer-revision/services/answer-revision.ts
import { factories } from '@strapi/strapi';
import {
  effectiveDraftScore,
  hasScoreChanged,
  recomputeFilingCurrentScore,
  recomputeSubmissionScore,
  recomputeFilingFinalScore
} from '../../../utils/scoring';

type Id = string;
type RelId = string | number;

export default factories.createCoreService('api::answer-revision.answer-revision', ({ strapi }) => ({
    /**
 * PUBLIC — listRevisions
 * Returns draft (if present) + non-draft snapshots for (filing, question).
 * Draft is returned first; snapshots follow in descending revision order.
 */
    async listRevisions({
        filingDocumentId,
        questionDocumentId,
        }: {
        filingDocumentId: string;
        questionDocumentId: string;
        }) {
        // Ensure the Question belongs to the Filing's framework_version
        await this.assertCoherence(filingDocumentId, questionDocumentId);

        // Fetch latest draft (preview so drafts are visible)
        const [draftRows, snapshots] = await Promise.all([
            strapi.documents('api::answer-revision.answer-revision').findMany({
            publicationState: 'preview',
            filters: {
                filing:   { documentId: filingDocumentId },
                question: { documentId: questionDocumentId },
                isDraft:  true,
            },
            fields: [
                'documentId','revisionIndex','isDraft','answerText',
                'modelScore','modelReason','modelSuggestion',
                'auditorScore','auditorReason','auditorSuggestion',
                'updatedAt'
            ] as any,
            populate: [],
            sort: ['updatedAt:desc'],
            pagination: { pageSize: 1 },
            } as any),

            // Fetch history snapshots (non-draft)
            strapi.documents('api::answer-revision.answer-revision').findMany({
            filters: {
                filing:   { documentId: filingDocumentId },
                question: { documentId: questionDocumentId },
                isDraft:  false,
            },
            fields: [
                'documentId','revisionIndex','isDraft','answerText',
                'modelScore','modelReason','modelSuggestion',
                'auditorScore','auditorReason','auditorSuggestion',
                'updatedAt'
            ] as any,
            populate: [],
            sort: ['revisionIndex:desc','createdAt:desc'],
            pagination: { pageSize: 200 },
            } as any),
        ]);

        const draft = (draftRows && draftRows[0]) ? draftRows[0] : null;

        // Return a flat array suitable for the controller’s transformResponse
        return draft ? [draft, ...snapshots] : snapshots;
    },
  
  
    /**
 * PUBLIC — Get the draft AnswerRevision for (filing, question),
 * or lazily create the canonical draft if none exists.
 */
    async getOrCreateDraft({
        filingDocumentId,
        questionDocumentId,
        userId,
        }: {
        filingDocumentId: string;
        questionDocumentId: string;
        userId?: number | null;
        }) {
        // Ensure the Question belongs to the Filing's framework_version
        const { filing, question } = await this.assertCoherence(filingDocumentId, questionDocumentId);

        // Find all drafts (preview mode so drafts are visible)
        const drafts = await strapi.documents('api::answer-revision.answer-revision').findMany({
            publicationState: 'preview',
            filters: {
            filing:   { documentId: filingDocumentId },
            question: { documentId: questionDocumentId },
            isDraft:  true,
            },
            fields: ['documentId',
          'answerText',
          'modelScore',
          'modelReason',
          'modelSuggestion',
          'auditorScore',
          'auditorReason',
          'auditorSuggestion',
          'updatedAt',
            ] as any,
            populate: [],
            sort: ['updatedAt:desc'],
            pagination: { pageSize: 10 },
        } as any);

        // If one or more drafts exist, keep the newest; (optional) clean up extras
        if (drafts?.length) {
            const [latest, ...extras] = drafts as any[];
            if (extras.length) {
            // Best-effort dedupe: delete older duplicates so invariant holds going forward
            for (const d of extras) {
                try {
                await strapi.documents('api::answer-revision.answer-revision').delete({
                    documentId: (d as any).documentId,
                } as any);
                } catch {
                // swallow cleanup failures; we still return the latest safely
                }
            }
            }
            return latest;
        }

        // No draft yet → create canonical draft (revisionIndex: 0)
        const draft = await this.createDraft({
            filingId:  (filing as any).id as string | number,
            questionId:(question as any).id as string | number,
            userId:    userId ?? undefined,
        });

        return draft;   
    },
    /**
   * PUBLIC — Called by the controller on PUT /filings/:filingId/questions/:questionId/draft
   * Saves the draft's answerText, runs ChatGPT scoring, and conditionally recomputes filing.currentScore.
   */
  async saveDraftWithModelScore({
    filingDocumentId,
    questionDocumentId,
    userId,
    answerText,
  }: {
    filingDocumentId: Id;
    questionDocumentId: Id;
    userId?: number | null;
    answerText: string;
  }) {
    // 1) Coherence + resolve draft
    const { filing, question } = await this.assertCoherence(filingDocumentId, questionDocumentId);
    
    // 🔒 1b) ACQUIRE ACTIVE LOCK if it doesn't exist
    const lockTtlSeconds = Math.max(1, Number(process.env.QUESTION_LOCK_TTL_SECONDS ?? 12));
    try {
      await strapi.service('api::question-lock.question-lock').acquire({
          filingDocumentId,
          questionDocumentId,
          userId: userId!,          // route policy guarantees auth
        ttlSeconds: lockTtlSeconds,
        });
      } catch (e: any) {
        // Ignore conflicts; if someone else holds it, the next check will 409.
        if (!e?.status || e.status !== 409) throw e;
      }

    // 🔒 1b) REQUIRE ACTIVE LOCK (and refresh TTL so the save has time to complete)
    await strapi.service('api::question-lock.question-lock').ensureLockHeld({
      filingDocumentId,
      questionDocumentId,
      userId: userId!,
      ttlSecondsOnSuccess: lockTtlSeconds, // refresh on entry to cover the whole save
    });

    let draft = await this.findDraft(filingDocumentId, questionDocumentId);
    if (!draft) {
      // Create a canonical draft if none exists (defensive; typical flow creates via getDraft)
      draft = await this.createDraft({
        filingId: (filing as any).id as RelId,
        questionId: (question as any).id as RelId,
        userId: userId ?? undefined,
      });
    }

    const beforeText: string = String((draft as any).answerText ?? '');
    const beforeEffective = effectiveDraftScore(draft);

    // 2) Update only answerText (policy enforces client field hygiene, but we double-guard)
    if (beforeText !== answerText) {
      draft = await strapi.documents('api::answer-revision.answer-revision').update({
        documentId: (draft as any).documentId,
        data: { answerText },
        status: 'published',
      } as any);
    }

    // 3) Score with ChatGPT (always attempt on save for now)
    let updated: any;
    try {
      updated = await this.scoreExistingDraftWithChatGPT({
        draftDocumentId: (draft as any).documentId,
        filingDocumentId,
        questionDocumentId,
      });
    } catch (err: any) {
      updated = draft; // fall back to pre-scoring draft
    }

    // 4) Recompute filing.currentScore if this question's effective draft score changed
    const afterEffective = effectiveDraftScore(updated);
    let updatedCurrentScore: number | undefined;
    if (hasScoreChanged(beforeEffective, afterEffective)) {
      updatedCurrentScore = await recomputeFilingCurrentScore(strapi,filingDocumentId);
    }

    // --- after you have `updated` (post-score) and maybe updatedCurrentScore ---
    // We’ll compare pre- vs post- to avoid noisy emits
    const prev = draft as any;       // snapshot from before we updated/scored
    const next = updated as any;     // snapshot after update + scoring

    // Normalize helpers
    const s = (v: unknown) => (v == null ? '' : String(v));
    const f = (v: unknown) => (v == null || v === '' ? null : Number(v));

    // Detect meaningful change (text or any model/auditor fields)
    const changed =
      s(prev.answerText)       !== s(next.answerText)       ||
      f(prev.modelScore)       !== f(next.modelScore)       ||
      s(prev.modelSuggestion)  !== s(next.modelSuggestion)  ||
      s(prev.modelReason)      !== s(next.modelReason)      ||
      f(prev.auditorScore)     !== f(next.auditorScore)     ||
      s(prev.auditorSuggestion)!== s(next.auditorSuggestion)||
      s(prev.auditorReason)    !== s(next.auditorReason);

    if (changed) {
      const revisionId = String(next.documentId ?? next.id); // your docs API uses documentId
      const topic = `question:${filingDocumentId}:${questionDocumentId}:${revisionId}`;
      const event = 'question:answer:state';
      const msgId = `${event}:${revisionId}:${Date.now()}`;

      // Payload per your request (map *Reason → *Reasoning for API shape)
      const payload = {
        revisionId,
        answerText: s(next.answerText),
        auditorScore: f(next.auditorScore),
        auditorSuggestion: s(next.auditorSuggestion) || null,
        auditorReasoning: s(next.auditorReason) || null,
        modelScore: f(next.modelScore),
        modelSuggestion: s(next.modelSuggestion) || null,
        modelReasoning: s(next.modelReason) || null,
        updatedAt: new Date().toISOString(),
      };

      // 4-arg form: (topic, id, event, data) — keeps a stable, replayable message id
      await strapi.service('api::realtime-sse.pubsub')
        .publish(topic, msgId, event, payload);
    }


    return { draft: updated, ...(updatedCurrentScore !== undefined ? { updatedCurrentScore } : {}) };
  },

  /**
   * Recompute all Submission.scores that reference this AnswerRevision (snapshot).
   * Returns the list of affected submission documentIds.
   */
  async recomputeLinkedSubmissionScores({
    revisionDocumentId,
    userId,
  }: { revisionDocumentId: string; userId?: number | null }) {
    const links = await strapi
      .documents('api::submission-answer.submission-answer')
      .findMany({
        publicationState: 'preview',
        filters: { answer_revision: { documentId: revisionDocumentId } },
        fields: ['documentId'] as any,
        populate: { submission: { fields: ['documentId'] as any } } as any,
        pagination: { pageSize: 5000 },
      } as any);

    const submissionIds = Array.from(
      new Set(
        (links as any[]).map((l) => l?.submission?.documentId).filter(Boolean)
      )
    );

    for (const sid of submissionIds) {
      await recomputeSubmissionScore(strapi, sid, { userId: userId ?? undefined });
    }

    return submissionIds;
  },

  // ------------------------------------------------------------------------------------
  // PRIVATE — ChatGPT scoring helper
  // ------------------------------------------------------------------------------------
  async scoreExistingDraftWithChatGPT({
    draftDocumentId,
    filingDocumentId,
    questionDocumentId,
  }: {
    draftDocumentId: string;
    filingDocumentId: string;
    questionDocumentId: string;
  }) {
    // --- helpers
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
    const toFixed = (n: number, dp = 2) => Number.parseFloat(n.toFixed(dp));
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // 1) Load question fields needed for scoring
    const question = await strapi.documents('api::question.question').findOne({
      documentId: questionDocumentId,
      fields: ['prompt', 'example', 'guidanceMarkdown', 'modelPrompt', 'maxScore'] as any,
      populate: [],
    } as any);
    if (!question) throw new Error('Question not found');

    const maxScore = Number((question as any).maxScore ?? 0);

    // 2) Find the latest NON-draft snapshot for auditorSuggestion (follow-up mode)
    const latestSnap = await strapi.documents('api::answer-revision.answer-revision').findMany({
      filters: {
        filing: { documentId: filingDocumentId },
        question: { documentId: questionDocumentId },
        isDraft: false,
      },
      fields: ['auditorSuggestion','auditorReason','auditorScore'] as any,
      populate: [],
      sort: ['revisionIndex:desc', 'createdAt:desc'],
      pagination: { pageSize: 1 },
    } as any);
    const snap = latestSnap?.[0] as any;
    
    const auditorReason: string | null = snap?.auditorReason ?? null;
    const auditorScore: number | null = snap?.auditorScore ?? null;

    // 3) Load the updated draft (must already exist; answerText just saved by caller)
    const draft = await strapi.documents('api::answer-revision.answer-revision').findOne({
      documentId: draftDocumentId,
      fields: ['documentId', 'answerText', 'revisionIndex', 'auditorScore', 'auditorReason', 'auditorSuggestion'] as any,
      populate: [],
    } as any);
    if (!draft) throw new Error('Draft not found');

    const answerText: string = String((draft as any).answerText ?? '');

    // 4) Compose prompt + modelPromptRaw
    // helper (put near the function top or inline)
    // helper
    const isNonEmpty = (s: any) => typeof s === 'string' && s.trim().length > 0;

    // pull auditor fields from the DRAFT only
    const draftSug   = (draft as any)?.auditorSuggestion ?? null;
    const draftReas  = (draft as any)?.auditorReason ?? null;
    const draftScore = (draft as any)?.auditorScore != null ? Number((draft as any).auditorScore) : null;

    // followup ONLY if the draft has the full triad
    const hasDraftTriad = isNonEmpty(draftSug) && isNonEmpty(draftReas) && draftScore != null;

    // 👇 replace your current mode line with this
    const mode = hasDraftTriad ? 'followup' : 'normal';

    const auditorSuggestion: string | null = (draft as any)?.auditorSuggestion ?? null;

          
    const { normalLine, followupLine, systemPrompt } = await this.loadScoringPrompts(strapi);

    const introLine = mode === 'normal' ? normalLine : followupLine;

    const sections: string[] =
      mode === 'normal'
        ? [
            normalLine,
            `Instruction:\n${(question as any).prompt}`,
            `Example:\n${(question as any).example}`,
            `Scoring Criteria (can only score the numbers mentioned, nothing else):\n${(question as any).guidanceMarkdown}`,
            `Scoring instructions:\n${(question as any).modelPrompt}`,
            `User Answer:\n${answerText}`,
            `MaxScore: ${maxScore}`,
          ]
        : [
            followupLine,
            `Instruction:\n${(question as any).prompt}`,
            `Scoring Criteria (can only score the numbers mentioned, nothing else):\n${(question as any).guidanceMarkdown}`,
            `Auditor Suggestion to be addressed:\n${auditorSuggestion}`,
            `Previous Auditor Reason (context only):\n${auditorReason}`,
            `Previous Auditor Score (context only): ${auditorScore}`,
            `User Answer:\n${answerText}`,
            `MaxScore: ${maxScore}`,
          ];

    const system = [systemPrompt].join(' ');

    const userContent = sections.join('\n\n');

    const modelPromptRaw = {
      mode,
      introLine,
      systemText: systemPrompt,
      instruction: (question as any).prompt,
      example: (question as any).example,
      guidanceMarkdown: (question as any).guidanceMarkdown,
      modelPrompt: (question as any).modelPrompt,
      answerText,
      maxScore,
        ...(auditorSuggestion ? { auditorSuggestion } : {}),
        ...(auditorReason ? { auditorReason } : {}),
        ...(auditorScore != null ? { auditorScore } : {}),
      meta: { questionId: questionDocumentId, filingId: filingDocumentId },
    };

    // 5) Call OpenAI with JSON-only output
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const t0 = Date.now();
    const completion = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
    });
    const latencyMs = Date.now() - t0;

    const raw = completion.choices?.[0]?.message?.content ?? '';
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Model did not return valid JSON');
    }

    // 6) Enforce shape + clamp + precision
    const rawScore = Number(parsed.modelScore);
    const modelScore = toFixed(clamp(Number.isFinite(rawScore) ? rawScore : 0, 0, maxScore), 2);
    const modelReason = String(parsed.modelReason ?? '').slice(0, 10000);
    const modelSuggestion = String(parsed.modelSuggestion ?? '').slice(0, 10000);

    // 7) Persist onto the SAME draft
    const currentIdx = Number((draft as any).revisionIndex ?? 0);

    const updated = await strapi.documents('api::answer-revision.answer-revision').update({
      documentId: draftDocumentId,
      data: {
        modelPromptRaw,
        modelResponseRaw: completion, // or completion.choices[0]
        modelScore,
        modelReason,
        modelSuggestion,
        latencyMs,
        revisionIndex: isFinite(currentIdx) ? currentIdx + 1 : 1,
      },
      status: 'published',
    } as any);

    // await this.logActivity({
    //   action: 'score',
    //   entityType: 'answer-revision',
    //   entityId: (draft as any).documentId,
    //   afterJson: {
    //     promptMeta: { mode, introLine, systemPrompt }
    //   },
    //   userId: undefined,
    // });

    return updated;
  },

  // ------------------------------------------------------------------------------------
  // INTERNAL HELPERS (typed to avoid compile errors; cast where relations are read)
  // ------------------------------------------------------------------------------------
  
  
  
  async assertCoherence(filingDocumentId: Id, questionDocumentId: Id) {
    const filing = await strapi.documents('api::filing.filing').findOne({
      documentId: filingDocumentId,
      fields: ['id'] as any,
      populate: { framework_version: { fields: ['id'] as any } } as any,
    } as any);
    const question = await strapi.documents('api::question.question').findOne({
      documentId: questionDocumentId,
      fields: ['id'] as any,
      populate: { framework_version: { fields: ['id'] as any } } as any,
    } as any);

    if (!filing || !question) {
      const which = !filing ? 'filing' : 'question';
      const err = new Error(`${which} not found`);
      (err as any).status = 400;
      throw err;
    }

    // Cast to access populated relations without TS complaints
    const filingFvId = (filing as any)?.framework_version?.id;
    const questionFvId = (question as any)?.framework_version?.id;

    if (!filingFvId || !questionFvId || filingFvId !== questionFvId) {
      const err = new Error('Question does not belong to filing’s framework version');
      (err as any).status = 400;
      throw err;
    }
    return { filing, question };
  },

  async findDraft(filingDocumentId: Id, questionDocumentId: Id) {
    const rows = await strapi.documents('api::answer-revision.answer-revision').findMany({
      publicationState: 'preview',
      filters: { filing: { documentId: filingDocumentId }, question: { documentId: questionDocumentId }, isDraft: true },
      fields: ['documentId', 'answerText', 'modelScore', 'auditorScore', 'updatedAt'] as any,
      populate: { question: { fields: ['documentId'] as any } } as any, // populated at runtime; cast when reading
      sort: ['updatedAt:desc'],
      pagination: { pageSize: 1 },
    } as any);
    return rows?.[0] ?? null;
  },

  async createDraft({
    filingId,
    questionId,
    userId,
  }: {
    filingId: RelId;
    questionId: RelId;
    userId?: number | null;
  }) {
    const draft = await strapi.documents('api::answer-revision.answer-revision').create({
      data: {
        revisionIndex: 0,
        answerText: '',
        isDraft: true,
        filing: { id: filingId },       // accepts string|number
        question: { id: questionId },   // accepts string|number
        ...(userId ? { users_permissions_user: { id: userId } } : {}),
      },
      status: 'published',
    } as any);
    return draft;
  },

  async logActivity({
    action,
    entityType,
    entityId,
    beforeJson,
    afterJson,
    userId,
  }: {
    action: 'edit' | 'score' | 'submit' | 'override' | 'lock';
    entityType: string;
    entityId: string;
    beforeJson?: any;
    afterJson?: any;
    userId?: number;
  }) {
    try {
      await strapi.documents('api::activity-log.activity-log').create({
        data: {
          action,
          entityType,
          entityId: String(entityId),
          beforeJson: beforeJson ?? null,
          afterJson: afterJson ?? null,
          ...(userId ? { users_permissions_user: { id: userId } } : {}),
        },
        status: 'published',
      } as any);
    } catch {
      // swallow logging failures
    }
  },

  async loadScoringPrompts(strapi: any) {
      const p = await strapi.documents('api::scoring-prompt.scoring-prompt').findFirst({
        fields: ['normalLine','followupLine','systemPrompt'] as any,
        populate: [],
      } as any);
      return {
        normalLine:   p?.normalLine   ?? "Evaluate whether the answer fully addresses the Auditor suggestion. Be strict, and specific in feedback.",
        followupLine: p?.followupLine ?? "Evaluate whether the answer fully addresses the Auditor suggestion. Be more lenient on score, but specific in feedback.",
        systemPrompt: p?.systemPrompt ?? [
          "You are an auditor for Blockworks. Interpret every protocol answer literally. Interpret Scoring Criteria literally",
          "Always respond with ONLY a single JSON object with keys:",
          "modelScore (number), modelReason (string), modelSuggestion (string)."
        ].join(' ')
      };
    },

    /**
 * PUBLIC — Return lean Question list (from 'fromOrder', inclusive) for the Filing's framework,
 * plus the DRAFT AnswerRevision for each Question (lazily created if missing).
 */
async getLeanWithDraftFromOrder(opts: {
  filingDocumentId: string;
  questionDocumentId: string;
  fromOrder: number;
  take: number;
  questionFields: string[];
  userId?: number | null;
}) {
  const {
    filingDocumentId,
    questionDocumentId,
    fromOrder,
    take,
    questionFields,
    userId,
  } = opts;

  // Ensure (filing, question) belong to the same framework_version
  const { filing, question } = await this.assertCoherence(filingDocumentId, questionDocumentId);

  // Resolve the framework_version.documentId from the Filing (authoritative)
  const filingFull = await strapi.documents('api::filing.filing').findFirst({
    publicationState: 'preview',
    filters: { documentId: filingDocumentId },
    populate: ['framework_version'],
    fields: ['id', 'documentId'],
  } as any);

  const frameworkDocId = (filingFull as any)?.framework_version?.documentId;
  if (!frameworkDocId) {
    throw new Error('Unable to resolve framework version for filing');
  }

  // Fetch Questions in the same framework, from order (inclusive), limited by 'take'
const questions = await strapi.documents('api::question.question').findMany({
  publicationState: 'preview',
  filters: {
    framework_version: { documentId: frameworkDocId },
    order: { $gte: fromOrder }, // inclusive "from"
  },
  fields: questionFields,
  sort: ['order:asc'],
  populate: [],
  // ⬇️ CHANGE: use top-level limit (or page/pageSize)
  limit: take,          // preferred
  // page: 1,           // alternative
  // pageSize: take,    // alternative
} as any);

// Optional belt-and-suspenders
const limited = (questions ?? []).slice(0, take);
const rows = await Promise.all(
  limited.map(async (q: any) => {
    const draft = await this.getOrCreateDraft({
      filingDocumentId,
      questionDocumentId: q.documentId,
      userId: userId ?? undefined,
    });

    return {
      id:               q?.id ?? null,
      documentId:       q?.documentId ?? null,
      header:           q?.header ?? null,
      subheader:        q?.subheader ?? null,
      prompt:           q?.prompt ?? null,
      example:          q?.example ?? null,
      guidanceMarkdown: q?.guidanceMarkdown ?? null,
      maxScore:         q?.maxScore ?? null,
      questionType:     q?.questionType ?? null,
      draft: {
        answerText:        draft?.answerText ?? null,
        auditorScore:      draft?.auditorScore ?? null,
        auditorReason:     draft?.auditorReason ?? null,
        auditorSuggestion: draft?.auditorSuggestion ?? null,
        modelScore:        draft?.modelScore ?? null,
        modelReason:       draft?.modelReason ?? null,
        modelSuggestion:   draft?.modelSuggestion ?? null,
      },
    };
  })
);

return rows;
},


}));
