import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  buildTreatmentContext,
  classifyAccountType,
  convertAmount,
  firstDayOfMonth,
  formatMoney,
  lastDayOfMonth,
  monthOf,
  summarizeSpending,
  todayLocal,
  type Settings,
} from '@manaclaude/shared';
import type { Env } from '../env';
import { selectAll, selectOne } from '../db/table';
import {
  accountsTable,
  balanceSnapshotsTable,
  budgetsTable,
  categoriesTable,
  holdingsTable,
  recurringTable,
  securitiesTable,
  tagsTable,
  taxLotsTable,
  transactionsTable,
  transferLinksTable,
} from '../db/tables';
import { loadRates } from '../fx/service';
import { searchReceipts } from '../receipts/service';
import { addCashTransaction } from '../services/cash';
import { editTransaction } from '../services/edits';
import { linkManually } from '../services/links';
import { getSettings } from '../services/settings';
import { getTransaction, listTransactions } from '../services/transactions';

export const READ_TOOLS = [
  'list_accounts',
  'search_transactions',
  'spending_summary',
  'budget_status',
  'holdings_with_lots',
  'net_worth_history',
  'list_recurring',
  'search_receipts',
] as const;

export const WRITE_TOOLS = [
  'categorize_transaction',
  'add_cash_transaction',
  'tag_transaction',
  'link_transfer',
] as const;

export interface McpAuthProps {
  userId: string;
  scopes: string[];
}

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Date as YYYY-MM-DD');
const month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe('Month as YYYY-MM');

function result(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Money as both minor units and a formatted string, so an assistant can't misread cents. */
function amount(value: number, currency: string) {
  return { minor: value, currency, formatted: formatMoney(value, currency) };
}

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * The MCP server for Sankar's own Claude and Perplexity accounts. Read tools
 * are always on. Write tools are a separate group, registered only when
 * Settings > MCP write tools is on AND the OAuth grant has the "write" scope;
 * they are marked as not read-only so the assistant asks before each call.
 */
export async function buildMcpServer(env: Env, props: McpAuthProps): Promise<McpServer> {
  const db = env.DB;
  const settings: Settings = await getSettings(db);
  const server = new McpServer(
    { name: 'mana-finance', version: '0.1.0' },
    {
      instructions:
        'Personal finance data for one person. Amounts come with minor units and a formatted string. Transfers between their own accounts and card payments are already left out of spending.',
    },
  );

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description: 'All accounts with type, currency, current balance and last sync.',
      inputSchema: { includeHidden: z.boolean().optional() },
      annotations: READ,
    },
    async ({ includeHidden }) => {
      const accounts = await selectAll(
        db,
        accountsTable,
        includeHidden ? '' : 'hidden = 0',
        [],
        'name',
      );
      return result({
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          institution: a.institutionName,
          type: a.type,
          subtype: a.subtype,
          classification: classifyAccountType(a.type),
          mask: a.mask,
          balance: amount(a.balance, a.currency),
          balanceAsOf: a.balanceAsOf,
        })),
      });
    },
  );

  server.registerTool(
    'search_transactions',
    {
      title: 'Search transactions',
      description: 'Find transactions by text, date range, account or category. Newest first.',
      inputSchema: {
        query: z.string().max(100).optional(),
        from: ymd.optional(),
        to: ymd.optional(),
        accountId: z.string().optional(),
        categoryId: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ,
    },
    async (args) => {
      const [txns, categories] = await Promise.all([
        listTransactions(db, {
          search: args.query,
          from: args.from,
          to: args.to,
          accountId: args.accountId,
          categoryId: args.categoryId,
          limit: args.limit ?? 50,
        }),
        selectAll(db, categoriesTable),
      ]);
      const names = new Map(categories.map((c) => [c.id, c.name]));
      return result({
        transactions: txns.map((t) => ({
          id: t.id,
          date: t.date,
          name: t.name,
          rawName: t.rawName,
          amount: amount(t.amount, t.currency),
          accountId: t.accountId,
          category: t.categoryId ? (names.get(t.categoryId) ?? t.categoryId) : null,
          categoryId: t.categoryId,
          pending: t.pending,
          linkedTransfer: Boolean(t.transferLinkId),
          notes: t.notes,
        })),
      });
    },
  );

  async function spendingFor(from: string, to: string, currency: string) {
    const [txns, categories, links, rates] = await Promise.all([
      selectAll(db, transactionsTable, 'date >= ? AND date <= ?', [from, to]),
      selectAll(db, categoriesTable),
      selectAll(db, transferLinksTable),
      loadRates(db),
    ]);
    const ctx = buildTreatmentContext(settings.moneyPolicies, categories, links);
    return { summary: summarizeSpending(txns, ctx, { from, to, currency, rates }), categories };
  }

  server.registerTool(
    'spending_summary',
    {
      title: 'Spending summary',
      description:
        'Spending and income for a date range, by category, in one currency (each transaction converted at its own day rate). Uses the money policies from Settings.',
      inputSchema: { from: ymd, to: ymd, currency: z.string().length(3).optional() },
      annotations: READ,
    },
    async ({ from, to, currency }) => {
      const cur = (currency ?? settings.primaryCurrency).toUpperCase();
      const { summary, categories } = await spendingFor(from, to, cur);
      const names = new Map(categories.map((c) => [c.id, c.name]));
      return result({
        from,
        to,
        spending: amount(summary.spending, cur),
        income: amount(summary.income, cur),
        net: amount(summary.net, cur),
        byCategory: Object.entries(summary.byCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([id, v]) => ({
            categoryId: id,
            category: names.get(id) ?? 'Uncategorized',
            amount: amount(v, cur),
          })),
        transactionsCounted: summary.counted,
        transactionsWithoutRate: summary.missingRate,
        policies: settings.moneyPolicies,
      });
    },
  );

  server.registerTool(
    'budget_status',
    {
      title: 'Budget status',
      description: 'Each category budget for a month: budgeted, spent, left.',
      inputSchema: { month: month.optional() },
      annotations: READ,
    },
    async (args) => {
      const m = args.month ?? monthOf(todayLocal());
      const budgets = await selectAll(db, budgetsTable, 'month = ?', [m]);
      const cur = budgets[0]?.currency ?? settings.primaryCurrency;
      const { summary, categories } = await spendingFor(firstDayOfMonth(m), lastDayOfMonth(m), cur);
      const names = new Map(categories.map((c) => [c.id, c.name]));
      return result({
        month: m,
        budgets: budgets.map((b) => {
          const spent = summary.byCategory[b.categoryId] ?? 0;
          return {
            categoryId: b.categoryId,
            category: names.get(b.categoryId) ?? b.categoryId,
            budgeted: amount(b.amount, b.currency),
            spent: amount(spent, cur),
            left: amount(b.amount - spent, cur),
            rollover: b.rollover,
          };
        }),
      });
    },
  );

  server.registerTool(
    'holdings_with_lots',
    {
      title: 'Holdings with tax lots',
      description:
        'Investment positions with quantity, price, value, cost basis and each open lot (acquired date, quantity, cost, short or long term).',
      inputSchema: { accountId: z.string().optional() },
      annotations: READ,
    },
    async ({ accountId }) => {
      const [holdings, securities, lots] = await Promise.all([
        selectAll(
          db,
          holdingsTable,
          accountId ? 'account_id = ?' : '',
          accountId ? [accountId] : [],
        ),
        selectAll(db, securitiesTable),
        selectAll(db, taxLotsTable),
      ]);
      const sec = new Map(securities.map((s) => [s.id, s]));
      const today = todayLocal();
      return result({
        holdings: holdings.map((h) => ({
          id: h.id,
          accountId: h.accountId,
          symbol: sec.get(h.securityId)?.symbol ?? h.securityId,
          name: sec.get(h.securityId)?.name ?? null,
          quantity: h.quantity,
          price: h.price,
          priceAsOf: h.priceAsOf,
          marketValue: amount(h.marketValue, h.currency),
          costBasis: h.costBasis === null ? null : amount(h.costBasis, h.currency),
          unrealizedGain:
            h.costBasis === null ? null : amount(h.marketValue - h.costBasis, h.currency),
          lots: lots
            .filter((l) => l.holdingId === h.id)
            .map((l) => ({
              acquiredOn: l.acquiredOn,
              quantity: l.quantity,
              costBasis: amount(l.costBasis, l.currency),
              term:
                Date.parse(today) - Date.parse(l.acquiredOn) > 365 * 86_400_000 ? 'long' : 'short',
              source: l.source,
            })),
        })),
      });
    },
  );

  server.registerTool(
    'net_worth_history',
    {
      title: 'Net worth history',
      description:
        'Net worth (assets minus liabilities) by date, converted to one currency with the rate of each date.',
      inputSchema: {
        from: ymd.optional(),
        to: ymd.optional(),
        currency: z.string().length(3).optional(),
      },
      annotations: READ,
    },
    async (args) => {
      const cur = (args.currency ?? settings.primaryCurrency).toUpperCase();
      const [accounts, snaps, rates] = await Promise.all([
        selectAll(db, accountsTable, 'include_in_net_worth = 1'),
        selectAll(db, balanceSnapshotsTable, '', [], 'date'),
        loadRates(db),
      ]);
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const totals = new Map<string, number>();
      for (const s of snaps) {
        const acc = byId.get(s.accountId);
        if (!acc) continue;
        if ((args.from && s.date < args.from) || (args.to && s.date > args.to)) continue;
        const v = convertAmount(s.balance, s.currency, cur, rates, { mode: 'on', date: s.date });
        if (v === null) continue;
        const signed = classifyAccountType(acc.type) === 'liability' ? -v : v;
        totals.set(s.date, (totals.get(s.date) ?? 0) + signed);
      }
      let current = 0;
      for (const a of accounts) {
        const v = convertAmount(a.balance, a.currency, cur, rates, { mode: 'latest' });
        if (v !== null) current += classifyAccountType(a.type) === 'liability' ? -v : v;
      }
      return result({
        currency: cur,
        current: amount(current, cur),
        history: [...totals.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, v]) => ({ date, netWorth: amount(v, cur) })),
      });
    },
  );

  server.registerTool(
    'list_recurring',
    {
      title: 'Recurring bills and subscriptions',
      description:
        'Recurring charges and income with frequency, expected amount, next due date and price history.',
      inputSchema: { status: z.enum(['active', 'paused', 'cancelled']).optional() },
      annotations: READ,
    },
    async ({ status }) => {
      const items = await selectAll(
        db,
        recurringTable,
        status ? 'status = ?' : '',
        status ? [status] : [],
      );
      return result({
        recurring: items.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          frequency: r.frequency,
          expected: amount(r.expectedAmount, r.currency),
          nextDueDate: r.nextDueDate,
          status: r.status,
          decision: r.decision,
          priceHistory: r.priceHistory.map((p) => ({
            date: p.date,
            amount: amount(p.amount, r.currency),
          })),
        })),
      });
    },
  );

  server.registerTool(
    'search_receipts',
    {
      title: 'Search receipts',
      description:
        'Receipts by merchant or line-item text and date, with totals, line items and the matched transaction.',
      inputSchema: {
        query: z.string().max(100).optional(),
        from: ymd.optional(),
        to: ymd.optional(),
      },
      annotations: READ,
    },
    async (args) => {
      const receipts = await searchReceipts(db, args);
      return result({
        receipts: receipts.map((r) => ({
          id: r.id,
          merchant: r.merchant,
          date: r.date,
          total: r.total === null || !r.currency ? null : amount(r.total, r.currency),
          lineItems: r.lineItems.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            amount: r.currency ? amount(l.amount, r.currency) : l.amount,
          })),
          matchedTransactionId: r.matchedTransactionId,
          status: r.status,
        })),
      });
    },
  );

  // ---- Write tools: off by default, separate group --------------------------
  const writeAllowed = settings.mcpWriteToolsEnabled && props.scopes.includes('write');
  if (!writeAllowed) return server;

  server.registerTool(
    'categorize_transaction',
    {
      title: 'Set a transaction category',
      description:
        "Set the category of one transaction. Counts as the user's own edit and teaches the categorizer.",
      inputSchema: { transactionId: z.string(), categoryId: z.string() },
      annotations: WRITE,
    },
    async ({ transactionId, categoryId }) => {
      const category = await selectOne(db, categoriesTable, 'id = ?', [categoryId]);
      if (!category)
        return error('No such category. Use spending_summary or list categories first.');
      const t = await editTransaction(db, transactionId, { categoryId });
      return result({ transactionId: t.id, categoryId: t.categoryId });
    },
  );

  server.registerTool(
    'add_cash_transaction',
    {
      title: 'Add a cash transaction',
      description:
        'Record cash spending (negative amount in minor units, e.g. -1250 for 12.50) in the default cash account for that currency.',
      inputSchema: {
        amount: z.number().int().describe('Minor units; negative for spending'),
        currency: z.string().length(3),
        name: z.string().max(200).optional(),
        categoryId: z.string().optional(),
        date: ymd.optional(),
      },
      annotations: WRITE,
    },
    async (args) => {
      if (args.amount === 0) return error('Amount cannot be zero.');
      const t = await addCashTransaction(db, {
        ...args,
        currency: args.currency.toUpperCase(),
        date: args.date ?? todayLocal(),
      });
      return result({
        transactionId: t.id,
        accountId: t.accountId,
        amount: amount(t.amount, t.currency),
      });
    },
  );

  server.registerTool(
    'tag_transaction',
    {
      title: 'Tag a transaction',
      description: 'Add a tag (by id or name) to one transaction.',
      inputSchema: { transactionId: z.string(), tag: z.string() },
      annotations: WRITE,
    },
    async ({ transactionId, tag }) => {
      const tags = await selectAll(db, tagsTable);
      const found = tags.find((t) => t.id === tag || t.name.toLowerCase() === tag.toLowerCase());
      if (!found) return error(`No tag "${tag}". Tags: ${tags.map((t) => t.name).join(', ')}`);
      const t = await getTransaction(db, transactionId);
      if (!t) return error('Transaction not found.');
      const next = t.tagIds.includes(found.id) ? t.tagIds : [...t.tagIds, found.id];
      await editTransaction(db, transactionId, { tagIds: next });
      return result({ transactionId, tagIds: next });
    },
  );

  server.registerTool(
    'link_transfer',
    {
      title: 'Link two transactions as a transfer',
      description:
        "Link money out of one of the user's accounts with money into another, so the pair is left out of spending and income.",
      inputSchema: { transactionId: z.string(), otherTransactionId: z.string() },
      annotations: WRITE,
    },
    async ({ transactionId, otherTransactionId }) => {
      try {
        const link = await linkManually(db, transactionId, otherTransactionId);
        return result({ linkId: link.id, kind: link.kind, impliedRate: link.impliedRate });
      } catch (e) {
        return error(e instanceof Error ? e.message : 'Could not link.');
      }
    },
  );

  return server;
}
