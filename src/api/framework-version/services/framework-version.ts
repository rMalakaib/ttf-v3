import { factories } from '@strapi/strapi';

function toISO(dateStr?: string | null, endOfDay = false): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default factories.createCoreService('api::framework-version.framework-version', ({ strapi }) => ({
  /**
   * Return filings (for a Framework Version) that HAVE a finalScore, with project name.
   * Optional finalizedAt date range: start/end as YYYY-MM-DD (inclusive).
   * Output: [{ projectName, projectId, filingId, finalScore, finalizedAt }]
   */
  async listFinalScores({
    frameworkVersionId,
    filingId,
    start,
    end,
  }: {
    frameworkVersionId?: string;
    filingId?: string;
    start?: string | null;
    end?: string | null;
  }) {
    // Use a local so we don't reassign the parameter (avoids no-param-reassign)
    let resolvedFrameworkVersionId = frameworkVersionId?.trim();

    // Resolve frameworkVersionId from filingId if needed
    if (!resolvedFrameworkVersionId) {
      if (!filingId) {
        throw new Error('frameworkVersionId or filingId is required');
      }

      // Minimal shape for the piece we need
      type FilingWithFV = {
        framework_version?: { documentId?: string };
      } | null;

      const filing = (await strapi.documents('api::filing.filing').findOne({
        documentId: filingId,
        publicationState: 'preview',
        fields: ['documentId'] as any,
        populate: {
          framework_version: { fields: ['documentId'] as any },
        } as any,
      } as any)) as unknown as FilingWithFV;

      if (!filing) throw new Error('filing not found');

      resolvedFrameworkVersionId = filing?.framework_version?.documentId?.trim();
      if (!resolvedFrameworkVersionId) throw new Error('filing has no framework_version');
    }

    const startISO = toISO(start ?? null, false);
    const endISO   = toISO(end ?? null, true);

    const filters: any = {
      framework_version: { documentId: resolvedFrameworkVersionId },
    };
    if (startISO || endISO) {
      filters.finalizedAt = {
        ...(startISO ? { $gte: startISO } : {}),
        ...(endISO   ? { $lte: endISO }   : {}),
      };
    }

    const rows = (await strapi.documents('api::filing.filing').findMany({
      publicationState: 'preview',
      filters,
      fields: ['documentId', 'finalScore', 'finalizedAt'] as any,
      populate: {
        project: { fields: ['documentId', 'domain', 'slug'] as any },
      } as any,
      sort: ['finalizedAt:desc', 'updatedAt:desc'],
      pagination: { pageSize: 5000 },
    } as any)) as any[];

    const out = rows
      .filter(r => r?.finalScore != null)
      .map(r => ({
        filingId: r.documentId,
        projectId: r?.project?.documentId ?? null,
        projectName: r?.project?.domain ?? r?.project?.slug ?? null,
        finalScore: Number(r.finalScore),
        finalizedAt: r.finalizedAt ?? null,
      }));

    return out;
  },

  /**
   * List all filings for a Framework Version, with currentScore, finalScore (if any),
   * and a list of submission scores filtered by submittedAt range (if provided).
   *
   * Returns: Array<{
   *   filingId: string;
   *   projectId: string | null;
   *   projectName: string | null;
   *   currentScore: number;
   *   finalScore: number | null;
   *   submissions: Array<{ submissionId: string; number: number; submittedAt: string; score: number | null }>;
   * }>
   */
  async listFilingsWithScores({
    frameworkVersionId,
    start,
    end,
  }: {
    frameworkVersionId: string;
    start?: string | null;
    end?: string | null;
  }) {
    const startISO = toISO(start ?? null, false);
    const endISO   = toISO(end ?? null, true);

    // Base filters: filings in this framework version
    const filingFilters: any = {
      framework_version: { documentId: frameworkVersionId },
    };

    // Build submission populate with optional date filter
    const submissionsPopulate: any = {
      fields: ['documentId', 'number', 'submittedAt', 'score'] as any,
      sort: ['submittedAt:asc'],
    };
    if (startISO || endISO) {
      submissionsPopulate.filters = {
        ...(startISO ? { submittedAt: { $gte: startISO } } : {}),
        ...(endISO   ? { submittedAt: { $lte: endISO } } : {}),
      };
    }

    const filings = await strapi.documents('api::filing.filing').findMany({
      publicationState: 'preview',
      filters: filingFilters,
      fields: ['documentId', 'currentScore', 'finalScore', 'finalizedAt'] as any,
      populate: {
        project: { fields: ['documentId', 'domain', 'slug'] as any },
        submissions: submissionsPopulate,
      } as any,
      sort: ['updatedAt:desc'],
      pagination: { pageSize: 5000 },
    } as any);

    const out = (filings as any[]).map((f) => {
      const projectId   = f?.project?.documentId ?? null;
      const projectName = f?.project?.domain ?? f?.project?.slug ?? null;

      const submissions = Array.isArray(f?.submissions) ? f.submissions.map((s: any) => ({
        submissionId: s.documentId,
        number: s.number,
        submittedAt: s.submittedAt,
        score: s.score != null ? Number(s.score) : null,
      })) : [];

      return {
        filingId: f.documentId,
        projectId,
        projectName,
        currentScore: Number(f?.currentScore ?? 0),
        finalScore: f?.finalScore != null ? Number(f.finalScore) : null,
        submissions,
      };
    });

    return out;
  },
}));
