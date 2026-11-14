import type { Receipt, ReceiptMatch, ReceiptResponse, Transaction } from '@manaclaude/shared';

/**
 * What the Worker said about a receipt it just stored (POST /v1/receipts):
 * the purchase it attached it to when the match was clear, and the other
 * likely purchases with its score and reason. Pure, for the matches view.
 */

export interface LikelyPurchase {
  match: ReceiptMatch;
  /** The purchase in the app's data, or null when it has not loaded here yet. */
  txn: Transaction | null;
}

export interface MatchesView {
  /** The purchase the Worker attached it to by itself, if any. */
  matched: LikelyPurchase | null;
  /** Other likely purchases, best first. */
  likely: LikelyPurchase[];
}

export function matchesView(
  response: Pick<ReceiptResponse, 'match' | 'candidates'>,
  transactions: readonly Transaction[],
): MatchesView {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const withTxn = (match: ReceiptMatch): LikelyPurchase => ({
    match,
    txn: byId.get(match.transactionId) ?? null,
  });
  const matchedId = response.match?.transactionId ?? null;
  const seen = new Set<string>(matchedId ? [matchedId] : []);
  const likely: LikelyPurchase[] = [];
  for (const c of [...response.candidates].sort((a, b) => b.score - a.score)) {
    if (seen.has(c.transactionId)) continue;
    seen.add(c.transactionId);
    likely.push(withTxn(c));
  }
  return { matched: response.match ? withTxn(response.match) : null, likely };
}

/** The Worker's reason as a sentence: "same amount, 1 day apart" to "Same amount, 1 day apart". */
export function reasonText(reason: string): string {
  const text = reason.trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/** Why there are no likely purchases, in plain words. */
export function noMatchText(receipt: Receipt): string {
  if (receipt.status === 'failed')
    return 'Your Worker could not read this receipt, so it has no likely purchases.';
  if (receipt.status === 'uploaded')
    return "AI is off on your Worker, so the receipt wasn't read and there are no likely purchases.";
  if (receipt.total === null || receipt.date === null)
    return 'Your Worker could not read the total or the date, so it has no likely purchases.';
  return 'Your Worker found no purchase with this amount within 3 days of the receipt.';
}
