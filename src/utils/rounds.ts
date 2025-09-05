// Single source of truth for MAX_ROUNDS and next round logic.

import { MAX_ROUNDS } from '../api/filing/utils/status';

export function getMaxRounds(): number {
  return MAX_ROUNDS;
}

/**
 * Find the smallest unused round number in [1..MAX_ROUNDS] for a Filing.
 * Throws if all rounds are consumed.
 */
export async function getNextSubmissionNumber(
  strapi: any,
  filingDocumentId: string
): Promise<number> {
  const MAX = getMaxRounds();

  const subs = await strapi.documents('api::submission.submission').findMany({
    publicationState: 'preview',
    filters: { filing: { documentId: filingDocumentId } },
    fields: ['number'] as any,
    sort: ['number:asc'],
    pagination: { pageSize: 5000 },
  } as any);

  const used = new Set<number>((subs as any[]).map(s => Number(s.number)));
  for (let i = 1; i <= MAX; i++) if (!used.has(i)) return i;

  throw Object.assign(new Error(`All ${MAX} rounds already used for this filing`), {
    code: 'MAX_ROUNDS_REACHED',
  });
}
