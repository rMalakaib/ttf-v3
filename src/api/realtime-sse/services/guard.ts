// path: src/api/realtime-sse/services/guard.ts
// Assumptions: Topics use either numeric id, document UUID, or slug.
// Access rules: admin/auditor can access everything; others must be project members.

type AnyUser = { id: number; role?: { name?: string } | null } | null | undefined;

const toRole = (user: AnyUser) => {
  const n = String(user?.role?.name ?? '').trim().toLowerCase();
  if (n === 'admin' || n === 'administrator') return 'admin' as const;
  if (n === 'auditor') return 'auditor' as const;
  return 'authenticated' as const;
};

const isUUID = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

const isNumericId = (s: string) => /^\d+$/.test(s);

// Projects: match documentId (preferred) or numeric id
const whereForProjectRef = (ref: string) => {
  if (isNumericId(ref)) return { id: Number(ref) };
  // treat any non-numeric string as a documentId (usually UUID)
  return { documentId: ref };
};

// Filings: match documentId (preferred) or numeric id
const whereForFilingRef = (ref: string) => {
  if (isNumericId(ref)) return { id: Number(ref) };
  return { documentId: ref };
};


const deny = () => {
  const err: any = new Error('internal run-time guard failed');
  err.name = 'ForbiddenError';   // nicer logs
  err.status = 403;              // Koa/Strapi will send 403 instead of 500
  err.statusCode = 403;          // some middlewares read statusCode
  err.expose = true;             // send message to client, not generic
  throw err;
};

// Questions: NO slug — match documentId or numeric id
const whereForQuestionRef = (ref: string) => {
  if (isNumericId(ref)) return { id: Number(ref) };
  return { documentId: ref };
};

// AnswerRevisions: NO slug — match documentId or numeric id
const whereForAnswerRevisionRef = (ref: string) => {
  if (isNumericId(ref)) return { id: Number(ref) };
  return { documentId: ref };
};


export default ({ strapi }) => {
  // --- Helpers -------------------------------------------------------------

  // filing belongs to project?
  const isFilingOwnedByProject = async (
    projectRef: string | undefined,
    filingRef: string
  ): Promise<boolean> => {
    if (!projectRef) return true;
    const filing = await strapi.db.query('api::filing.filing').findOne({
      where: whereForFilingRef(filingRef),
      select: ['id'],
      populate: { project: { select: ['id', 'documentId'] } }, // ← no slug
    });
    const proj = filing?.project;
    if (!proj?.id) return false;

    const want = String(projectRef);
    return (
      want === String(proj.documentId) ||
      (isNumericId(want) && Number(want) === Number(proj.id))
    );
  };

  // question belongs to the SAME framework_version as the filing?
  const isQuestionOwnedByFilingVersion = async (
    questionRef: string | undefined,
    filingRef: string
  ): Promise<boolean> => {
    if (!questionRef) return true;
    const filing = await strapi.db.query('api::filing.filing').findOne({
      where: whereForFilingRef(filingRef),
      select: ['id'],
      populate: { framework_version: { select: ['id', 'documentId'] } },
    });
    const fvFiling = filing?.framework_version;
    if (!fvFiling?.id) return false;

    const question = await strapi.db.query('api::question.question').findOne({
      where: whereForQuestionRef(questionRef),
      select: ['id'],
      populate: { framework_version: { select: ['id', 'documentId'] } },
    });
    const fvQuestion = question?.framework_version;
    if (!fvQuestion?.id) return false;

    return (
      String(fvQuestion.documentId) === String(fvFiling.documentId) ||
      Number(fvQuestion.id) === Number(fvFiling.id)
    );
  };

  // answer-revision belongs to the SAME filing?
  const isAnswerRevisionOwnedByFiling = async (
    answerRevisionRef: string | undefined,
    filingRef: string
  ): Promise<boolean> => {
    if (!answerRevisionRef) return true;
    const ar = await strapi.db.query('api::answer-revision.answer-revision').findOne({
      where: whereForAnswerRevisionRef(answerRevisionRef),
      select: ['id'],
      populate: { filing: { select: ['id', 'documentId'] } }, // ← no slug
    });
    const arFiling = ar?.filing;
    if (!arFiling?.id) return false;

    const want = String(filingRef);
    return (
      want === String(arFiling.documentId) ||
      (isNumericId(want) && Number(want) === Number(arFiling.id))
    );
  };



    const userHasProjectAccess = async (user: AnyUser, projectRef: string): Promise<boolean> => {
    const role = toRole(user);
    if (role === 'admin' || role === 'auditor') return true;
    if (!user?.id) return false;

    const count = await strapi.db.query('api::project.project').count({
      where: {
        $and: [
          whereForProjectRef(projectRef),                    // ← docId or numeric id
          { users_permissions_users: { id: user.id } },
        ],
      },
    });
    return count > 0;
  };

  const userHasFilingAccess = async (user: AnyUser, filingRef: string): Promise<boolean> => {
    const role = toRole(user);
    if (role === 'admin' || role === 'auditor') return true;
    if (!user?.id) return false;

    const filing = await strapi.db.query('api::filing.filing').findOne({
      where: whereForFilingRef(filingRef),                  // ← docId or numeric id
      select: ['id'],
      populate: { project: { select: ['id', 'documentId'] } }, // ← no slug
    });
    if (!filing?.project?.id) return false;

    return userHasProjectAccess(user, String(filing.project.documentId ?? filing.project.id));
  };


  // --- Public API ----------------------------------------------------------

  const assertCanSubscribe = async (user: AnyUser, topics: string[], projectRefFromQuery?: string ) => {
    for (const t of topics) {
      const [scope, id1, id2, id3] = String(t || '').split(':');

      if (scope === 'user') {
        if (String(user?.id) !== id1) deny();
        continue;
      }

      if (scope === 'project') {
        const ok = await userHasProjectAccess(user, id1);
        if (!ok) deny();
        continue;
      }

      if (scope === 'filing') {
        const ok = await userHasFilingAccess(user, id1);
        if (!ok) deny();

        if (!(await isFilingOwnedByProject(projectRefFromQuery, id1))) deny();
        continue;
      }

      if (scope === 'question') {
        // question:{filingId}:{questionId}:{answerRevisionId} -> gate by the filing
        const ok = await userHasFilingAccess(user, id1);
        if (!ok) deny();

        // NEW: filing must belong to the project (if provided)
        if (!(await isFilingOwnedByProject(projectRefFromQuery, id1))) deny();

        // NEW: question must belong to the filing's framework_version
        if (!(await isQuestionOwnedByFilingVersion(id2, id1))) deny();

        // NEW: answer-revision (if provided) must belong to this filing
        if (!(await isAnswerRevisionOwnedByFiling(id3, id1))) deny();
        continue;
      }

      // Unknown scope: deny by default
        deny();;
    }
  };

  return {
    assertCanSubscribe,
    userHasProjectAccess,
    userHasFilingAccess,
  };
};
