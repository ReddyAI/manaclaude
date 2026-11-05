import type { Id, LocalDate, MinorUnits } from '../model/common';

/** Lower case, single spaces, no punctuation, so cosmetic changes don't break matching. */
export function normalizeDescription(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 64-bit FNV-1a as 16 hex characters. Fast, deterministic and the same in the app and the Worker. */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(input);
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export interface FingerprintInput {
  date: LocalDate;
  amount: MinorUnits;
  rawName: string;
}

/**
 * Import identity for rows without a stable id (research/sure/rea.md SURE-003):
 * account, date, amount, normalised description and the occurrence number of
 * that combination within the file. Two identical coffees in one file get
 * occurrence 1 and 2, so both are kept, and a repeat import of the same file
 * produces the same two fingerprints and adds nothing.
 */
export function importFingerprint(
  accountId: Id,
  row: FingerprintInput,
  occurrence: number,
): string {
  const key = `${accountId}|${row.date}|${row.amount}|${normalizeDescription(row.rawName)}|${occurrence}`;
  return `fp_${fnv1a64(key)}`;
}

/** Occurrence numbers (1, 2, ...) for each row, counted per account+date+amount+description. */
export function assignOccurrences(
  rows: readonly (FingerprintInput & { accountId: Id })[],
): number[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = `${r.accountId}|${r.date}|${r.amount}|${normalizeDescription(r.rawName)}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n;
  });
}
