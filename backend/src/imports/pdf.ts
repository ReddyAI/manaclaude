import { normalizeAiStatement, type AiStatementJson, type CurrencyCode, type ParsedStatement } from '@manaclaude/shared';
import { completeJson, type AiClient, type JsonSchema } from '../ai/provider';

export const STATEMENT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    accountName: { type: ['string', 'null'] },
    accountMask: { type: ['string', 'null'], description: 'Last 4 digits only' },
    currency: { type: ['string', 'null'], description: 'ISO code like INR or USD' },
    periodStart: { type: ['string', 'null'] },
    periodEnd: { type: ['string', 'null'] },
    openingBalance: { type: ['string', 'null'] },
    closingBalance: { type: ['string', 'null'] },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          description: { type: 'string' },
          debit: { type: ['string', 'null'] },
          credit: { type: ['string', 'null'] },
          balance: { type: ['string', 'null'] },
        },
        required: ['date', 'description', 'debit', 'credit', 'balance'],
      },
    },
  },
  required: [
    'accountName',
    'accountMask',
    'currency',
    'periodStart',
    'periodEnd',
    'openingBalance',
    'closingBalance',
    'transactions',
  ],
};

const SYSTEM = `You read bank and credit card statements (including Indian NRE and NRO statements) and return their transactions as JSON.
Rules:
- Copy every transaction row in order. Do not invent, merge or skip rows.
- Copy amounts exactly as printed, as strings, without currency symbols. Put money out in "debit" and money in in "credit".
- Copy dates exactly as printed.
- accountMask is the last 4 digits of the account number, never the full number.
- Use null when the statement does not show a value.`;

/** Sends the PDF to the AI layer and checks the result (opening + rows = closing). */
export async function extractStatement(
  ai: AiClient,
  pdf: Uint8Array<ArrayBuffer>,
  fileName: string,
  fallbackCurrency: CurrencyCode,
): Promise<ParsedStatement> {
  const json = await completeJson<AiStatementJson>(ai, {
    system: SYSTEM,
    prompt: 'Extract the account details and every transaction from this statement.',
    schema: STATEMENT_SCHEMA,
    pdf: { data: pdf, fileName },
    maxTokens: 8000,
  });
  return normalizeAiStatement(json, fallbackCurrency);
}
