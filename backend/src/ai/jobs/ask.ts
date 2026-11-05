import {
  addMonthsToMonth,
  buildTreatmentContext,
  firstDayOfMonth,
  formatMoney,
  lastDayOfMonth,
  monthOf,
  summarizeSpending,
} from '@manaclaude/shared';
import type { Env } from '../../env';
import { selectAll } from '../../db/table';
import { accountsTable, categoriesTable, transactionsTable, transferLinksTable } from '../../db/tables';
import { loadRates } from '../../fx/service';
import { getSettings } from '../../services/settings';
import { getAi, type AiDeps } from '../provider';

/**
 * Questions in plain English ("How much did I spend on restaurants in
 * October?"). The answer is written from monthly summaries computed with the
 * shared policy code, so the AI never adds up raw transactions itself.
 */
export async function answerQuestion(env: Env, question: string, deps: AiDeps = {}, today = new Date().toISOString().slice(0, 10)): Promise<string> {
  const db = env.DB;
  const settings = await getSettings(db);
  const ai = getAi(env, settings, deps);
  const [categories, links, rates, accounts] = await Promise.all([
    selectAll(db, categoriesTable),
    selectAll(db, transferLinksTable),
    loadRates(db),
    selectAll(db, accountsTable, 'hidden = 0'),
  ]);
  const ctx = buildTreatmentContext(settings.moneyPolicies, categories, links);
  const currency = settings.primaryCurrency;
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const months: string[] = [];
  const thisMonth = monthOf(today);
  const from = firstDayOfMonth(addMonthsToMonth(thisMonth, -5));
  const txns = await selectAll(db, transactionsTable, 'date >= ?', [from]);
  for (let i = 5; i >= 0; i -= 1) {
    const m = addMonthsToMonth(thisMonth, -i);
    const s = summarizeSpending(txns, ctx, { from: firstDayOfMonth(m), to: lastDayOfMonth(m), currency, rates });
    const cats = Object.entries(s.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => `${names.get(id) ?? 'Uncategorized'} ${formatMoney(v, currency)}`)
      .join('; ');
    months.push(`${m}: spending ${formatMoney(s.spending, currency)}, income ${formatMoney(s.income, currency)}. By category: ${cats || 'none'}`);
  }
  const accountLines = accounts.map((a) => `${a.name} (${a.type}, ${a.currency}): ${formatMoney(a.balance, a.currency)}`);
  return ai.complete({
    system:
      'You answer questions about one person\'s own finances using only the facts given. Be brief and specific. If the facts do not answer the question, say what is missing. Transfers between their own accounts and card payments are already left out of spending.',
    prompt: `Today: ${today}\nAccounts:\n${accountLines.join('\n')}\n\nMonthly totals (${currency}):\n${months.join('\n')}\n\nQuestion: ${question}`,
    maxTokens: 800,
  });
}
