import { normalizeDescription } from '@manaclaude/shared';

const PREFIXES = [
  /^(sq|tst|sp|py|pp|paypal|square|toast|clover)\s*\*\s*/i,
  /^(pos|debit card purchase|card purchase|purchase|recurring payment|checkcard|visa|ach debit|ach)\s+/i,
  /^(upi|imps|neft|rtgs)[-/ ]+/i,
];
const SUFFIXES = [
  /\s+(store|str|#)\s*\d+.*$/i,
  /\s+#\s*\d+.*$/,
  /\s+\d{3,}.*$/,
  /\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?.*$/,
  /\s+[A-Z]{2}\s*$/,
  /@[a-z0-9.]+$/i,
];

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length <= 2 && /^(of|at|in|on|by|to|and|&)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Rule-based merchant cleanup that runs before (and without) AI:
 * "SQ *GREENLEAF FLORIST" -> "Greenleaf Florist", "STARBUCKS STORE 04412" -> "Starbucks".
 */
export function cleanMerchantName(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  for (const p of PREFIXES) s = s.replace(p, '');
  for (let i = 0; i < 3; i += 1) for (const p of SUFFIXES) s = s.replace(p, '');
  s = s.replace(/[*_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return raw.trim();
  return /[a-z]/.test(s) ? s : titleCase(s);
}

/** Key used to learn from corrections: the cleaned, normalised merchant name. */
export function merchantKey(raw: string): string {
  return normalizeDescription(cleanMerchantName(raw));
}
