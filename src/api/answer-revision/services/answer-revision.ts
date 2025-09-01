// path: src/api/answer-revision/services/answer-revision.ts
import { factories } from '@strapi/strapi';
import {
  effectiveDraftScore,
  hasScoreChanged,
  recomputeFilingCurrentScore,
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
            fields: ['documentId','answerText','modelScore','auditorScore','updatedAt'] as any,
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

      // Activity: edit
      await this.logActivity({
        action: 'edit',
        entityType: 'answer-revision',
        entityId: (draft as any).documentId,
        beforeJson: { answerText: beforeText },
        afterJson: { answerText },
        userId: userId ?? undefined,
      });
    }

    // 3) Score with ChatGPT (always attempt on save for now)
    let updated: any;
    try {
      updated = await this.scoreExistingDraftWithChatGPT({
        draftDocumentId: (draft as any).documentId,
        filingDocumentId,
        questionDocumentId,
      });

      // Activity: score
      await this.logActivity({
        action: 'score',
        entityType: 'answer-revision',
        entityId: (draft as any).documentId,
        afterJson: {
          modelScore: (updated as any).modelScore,
          modelReason: (updated as any).modelReason,
          modelSuggestion: (updated as any).modelSuggestion,
          latencyMs: (updated as any).latencyMs,
        },
        userId: userId ?? undefined,
      });
    } catch (err: any) {
      // Scoring failed; keep saved text. Log the error and return current draft.
      await this.logActivity({
        action: 'score',
        entityType: 'answer-revision',
        entityId: (draft as any).documentId,
        afterJson: { error: String(err?.message ?? err) },
        userId: userId ?? undefined,
      });
      updated = draft; // fall back to pre-scoring draft
    }

    // 4) Recompute filing.currentScore if this question's effective draft score changed
    const afterEffective = effectiveDraftScore(updated);
    let updatedCurrentScore: number | undefined;
    if (hasScoreChanged(beforeEffective, afterEffective)) {
      updatedCurrentScore = await recomputeFilingCurrentScore(strapi,filingDocumentId);
    }

    return { draft: updated, ...(updatedCurrentScore !== undefined ? { updatedCurrentScore } : {}) };
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

    const sections: string[] =
      mode === 'normal'
        ? [
            `Instruction:\n${(question as any).prompt}`,
            `Example:\n${(question as any).example}`,
            `Scoring Criteria (can only score the numbers mentioned, nothing else):\n${(question as any).guidanceMarkdown}`,
            `Scoring instructions:\n${(question as any).modelPrompt}`,
            `User Answer:\n${answerText}`,
            `MaxScore: ${maxScore}`,
          ]
        : [
            `Evaluate whether the answer fully addresses the Auditor suggestion. Be more linient on score, but specific in feedback.`,
            `Instruction:\n${(question as any).prompt}`,
            `Scoring Criteria (can only score the numbers mentioned, nothing else):\n${(question as any).guidanceMarkdown}`,
            `Auditor Suggestion to be addressed:\n${auditorSuggestion}`,
            `Previous Auditor Reason (context only):\n${auditorReason}`,
            `Previous Auditor Score (context only): ${auditorScore}`,
            `User Answer:\n${answerText}`,
            `MaxScore: ${maxScore}`,
          ];

    const system = [
      'You are an auditor for Blockworks. Interpret every protocol answer literally. Interpret Scoring Criteria literally',
      'Always respond with ONLY a single JSON object with keys:',
      'modelScore (number), modelReason (string), modelSuggestion (string).',
    ].join(' ');

    const userContent = sections.join('\n\n');

    const modelPromptRaw = {
      mode,
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
}));
