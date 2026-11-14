import {
  ACTIVE_TRANSFER_LINK_STATUSES,
  convertAmount,
  daysBetween,
  impliedRateOf,
  relativeDifference,
  type Account,
  type Category,
  type FxRate,
  type Id,
  type Transaction,
  type TransferLink,
  type TransferLinkKind,
} from '@manaclaude/shared';
import { bulkInsertSpecs, runSpecs, type StatementSpec } from '../db/bulk';
import { selectAll } from '../db/table';
import {
  accountsTable,
  categoriesTable,
  fxRatesTable,
  transactionsTable,
  transferLinksTable,
} from '../db/tables';
import { newId, nowIso } from '../util/ids';

/** Matching window and tolerance from the addendum. */
export const MATCH_MAX_DAYS = 5;
export const MATCH_FX_TOLERANCE = 0.02;
const TRANSFER_WORDS =
  /\b(transfer|xfer|trf|payment|pmt|autopay|zelle|ach|wise|remitly|remittance|neft|imps|rtgs|atm|cash withdrawal|deposit|thank you)\b/i;

export interface MatchCandidate {
  out: Transaction;
  in: Transaction;
  kind: TransferLinkKind;
  score: number;
  impliedRate: number;
}

export interface MatchPlan {
  auto: MatchCandidate[];
  suggested: MatchCandidate[];
}

function eligible(t: Transaction): boolean {
  return (
    !t.isSplitParent && !t.excluded && !t.pending && t.transferLinkId === null && t.amount !== 0
  );
}

function linkKind(
  outAcc: Account,
  inAcc: Account,
  out: Transaction,
  into: Transaction,
): TransferLinkKind {
  if (inAcc.type === 'credit_card') return 'card_payment';
  if (inAcc.type === 'loan' || inAcc.type === 'mortgage') return 'loan_payment';
  if (inAcc.type === 'brokerage' || inAcc.type === 'retirement') {
    return outAcc.type === 'brokerage' || outAcc.type === 'retirement'
      ? 'transfer'
      : 'investment_contribution';
  }
  if (inAcc.type === 'cash' || /\batm\b/i.test(out.rawName) || /\batm\b/i.test(into.rawName)) {
    return inAcc.type === 'cash' ? 'atm_withdrawal' : 'transfer';
  }
  return 'transfer';
}

/** A side the user put in a spending or income category is not a transfer. */
function userSaysNotTransfer(t: Transaction, categories: ReadonlyMap<Id, Category>): boolean {
  if (!t.userEditedFields.includes('categoryId') || !t.categoryId) return false;
  return categories.get(t.categoryId)?.kind !== 'transfer';
}

/**
 * Pairs money out of one account with money into another account of yours:
 * opposite signs, equal amounts (within 2% after FX for cross-currency pairs),
 * dates within 5 days. Memos with transfer words score higher. A pair with
 * exactly one candidate on both sides is linked automatically; anything else
 * becomes suggestions. Pairs already stored (including rejected ones) are
 * never proposed again.
 */
export function planTransferMatches(input: {
  transactions: readonly Transaction[];
  accounts: readonly Account[];
  categories: readonly Category[];
  rates: readonly FxRate[];
  existingLinks: readonly TransferLink[];
}): MatchPlan {
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const categories = new Map(input.categories.map((c) => [c.id, c]));
  const knownPairs = new Set(
    input.existingLinks.map((l) => `${l.outTransactionId}>${l.inTransactionId}`),
  );
  const pool = input.transactions.filter(
    (t) => eligible(t) && accounts.has(t.accountId) && !userSaysNotTransfer(t, categories),
  );
  const outs = pool.filter((t) => t.amount < 0);
  const ins = pool.filter((t) => t.amount > 0);
  const byOut = new Map<Id, MatchCandidate[]>();
  const byIn = new Map<Id, MatchCandidate[]>();
  const known = new Set<MatchCandidate>();
  for (const out of outs) {
    const outAcc = accounts.get(out.accountId)!;
    for (const into of ins) {
      if (into.accountId === out.accountId) continue;
      const days = Math.abs(daysBetween(out.date, into.date));
      if (days > MATCH_MAX_DAYS) continue;
      const inAcc = accounts.get(into.accountId)!;
      const words = TRANSFER_WORDS.test(out.rawName) || TRANSFER_WORDS.test(into.rawName);
      // Money into a card or loan without a payment word is more likely a refund
      // that happens to match a purchase elsewhere.
      const debtSide = ['credit_card', 'loan', 'mortgage', 'other_liability'].includes(inAcc.type);
      if (debtSide && !words) continue;
      let diff: number;
      if (out.currency === into.currency) {
        if (-out.amount !== into.amount) continue;
        diff = 0;
      } else {
        // Cross-currency pairs need a transfer word or an NRE/NRO-style account to be considered.
        const remittanceAccount = ['nre', 'nro', 'fcnr'].includes(String(inAcc.subtype ?? ''));
        if (!words && !remittanceAccount) continue;
        const converted = convertAmount(-out.amount, out.currency, into.currency, input.rates, {
          mode: 'on',
          date: out.date,
        });
        if (converted === null) continue;
        diff = relativeDifference(converted, into.amount);
        if (diff > MATCH_FX_TOLERANCE) continue;
      }
      const key = `${out.id}>${into.id}`;
      const candidate: MatchCandidate = {
        out,
        in: into,
        kind: linkKind(outAcc, inAcc, out, into),
        score: Math.max(0, Math.min(1, 0.8 - days * 0.05 - diff * 5 + (words ? 0.2 : 0))),
        impliedRate: impliedRateOf(out.amount, out.currency, into.amount, into.currency),
      };
      // Known pairs still count towards ambiguity but are never re-proposed.
      byOut.set(out.id, [...(byOut.get(out.id) ?? []), candidate]);
      byIn.set(into.id, [...(byIn.get(into.id) ?? []), candidate]);
      if (knownPairs.has(key)) known.add(candidate);
    }
  }
  const auto: MatchCandidate[] = [];
  const suggested: MatchCandidate[] = [];
  for (const list of byOut.values()) {
    const fresh = list.filter((c) => !known.has(c));
    if (fresh.length === 0) continue;
    const onlyOne = list.length === 1 && (byIn.get(list[0]!.in.id)?.length ?? 0) === 1;
    if (onlyOne) auto.push(fresh[0]!);
    else suggested.push(...fresh);
  }
  return { auto, suggested };
}

export interface MatchRunResult {
  linked: number;
  suggested: number;
}

/**
 * Runs the matcher against D1 and writes its decisions. Safe to run any
 * number of times: the unique indexes on transfer_links stop a second active
 * link for a transaction and a second row for the same pair.
 */
export async function runTransferMatcher(
  db: D1Database,
  options: { from?: string; to?: string } = {},
): Promise<MatchRunResult> {
  const where = options.from && options.to ? 'date >= ? AND date <= ?' : '';
  const params = options.from && options.to ? [options.from, options.to] : [];
  const [transactions, accounts, categories, rates, existingLinks] = await Promise.all([
    selectAll(
      db,
      transactionsTable,
      where ? `${where} AND transfer_link_id IS NULL` : 'transfer_link_id IS NULL',
      params,
    ),
    selectAll(db, accountsTable),
    selectAll(db, categoriesTable),
    selectAll(db, fxRatesTable),
    selectAll(db, transferLinksTable),
  ]);
  const plan = planTransferMatches({ transactions, accounts, categories, rates, existingLinks });
  const now = nowIso();
  // Multi-row writes: three queries at most, however many links (Free plan query limit).
  // The unique indexes (one active link per side, one row per pair) skip anything a
  // concurrent run stored first, and linkIdsSpec only points rows at links that exist.
  const autoLinks = plan.auto.map((c) => linkFromCandidate(c, 'auto', 'matcher', now));
  const suggestedLinks = plan.suggested.map((c) =>
    linkFromCandidate(c, 'suggested', 'matcher', now),
  );
  let linked = 0;
  if (autoLinks.length > 0) {
    const results = await runSpecs(db, [
      ...existingLinkSpecs(autoLinks),
      linkIdsSpec(autoLinks, now),
    ]);
    linked = results.slice(0, -1).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }
  let suggested = 0;
  if (suggestedLinks.length > 0) {
    const results = await runSpecs(db, existingLinkSpecs(suggestedLinks));
    suggested = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }
  return { linked, suggested };
}

/** Do not recreate links whose endpoints were deleted after the matching read. */
export function existingLinkSpecs(links: TransferLink[]): StatementSpec[] {
  const fields = Object.keys(transferLinksTable.columns);
  const out = fields.indexOf('outTransactionId');
  const into = fields.indexOf('inTransactionId');
  return bulkInsertSpecs(transferLinksTable, links, 'ignore').map((s) => ({
    ...s,
    sql: s.sql.replace(
      'WHERE true',
      `WHERE EXISTS (SELECT 1 FROM transactions
      WHERE id = json_extract(value, '$[${out}]')) AND EXISTS (SELECT 1 FROM transactions
      WHERE id = json_extract(value, '$[${into}]'))`,
    ),
  }));
}

export function linkFromCandidate(
  c: Pick<MatchCandidate, 'out' | 'in' | 'kind' | 'impliedRate'> & { score: number | null },
  status: TransferLink['status'],
  matchedBy: TransferLink['matchedBy'],
  now: string,
): TransferLink {
  return {
    id: newId('tl'),
    outTransactionId: c.out.id,
    inTransactionId: c.in.id,
    outAmount: Math.abs(c.out.amount),
    outCurrency: c.out.currency,
    inAmount: Math.abs(c.in.amount),
    inCurrency: c.in.currency,
    impliedRate: c.impliedRate,
    status,
    kind: c.kind,
    matchScore: c.score,
    matchedBy,
    createdAt: now,
    updatedAt: now,
  };
}

export function isActiveLink(link: TransferLink): boolean {
  return ACTIVE_TRANSFER_LINK_STATUSES.includes(link.status);
}

/**
 * Sets transfer_link_id on both sides of each link that is stored (a link the
 * unique indexes skipped sets nothing), in one statement.
 */
export function linkIdsSpec(
  links: readonly Pick<TransferLink, 'id' | 'outTransactionId' | 'inTransactionId'>[],
  now: string,
): StatementSpec {
  const sides = links.flatMap((l) => [
    [l.outTransactionId, l.id],
    [l.inTransactionId, l.id],
  ]);
  return {
    sql: `UPDATE transactions SET transfer_link_id = json_extract(j.value, '$[1]'), updated_at = ?1
      FROM json_each(?2) AS j
      WHERE transactions.id = json_extract(j.value, '$[0]')
        AND transactions.transfer_link_id IS NULL
        AND EXISTS (SELECT 1 FROM transfer_links l WHERE l.id = json_extract(j.value, '$[1]'))`,
    params: [now, JSON.stringify(sides)],
    rows: sides.length,
  };
}
