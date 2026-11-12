import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  DISPLAY_CURRENCY_MODES,
  IMPORT_FORMATS,
  LOOKS,
  todayLocal,
  type CsvMapping,
  type ImportFormat,
  type Rule,
  type AiStatusResponse,
  type FxLatestResponse,
  type ImportResponse,
  type TransferLinkStatus,
} from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import {
  ConnectorConfigError,
  ConnectorRateLimitedError,
  ConnectorRepairNeededError,
  LinkInputError,
  ProviderDataError,
  ProviderHttpError,
} from '@manaclaude/connectors';
import type { Env } from '../env';
import { AiDisabledError, AiUnavailableError, providerStatus, type AiDeps } from '../ai/provider';
import { answerQuestion } from '../ai/jobs/ask';
import { JOBS, runJob, type JobName } from '../ai/jobs';
import { listRecaps } from '../ai/jobs/recap';
import { insertStatement, selectAll, selectOne, updateStatement } from '../db/table';
import {
  accountsTable,
  categoriesTable,
  connectionsTable,
  receiptsTable,
  recurringTable,
  rulesTable,
} from '../db/tables';
import {
  backfillFrankfurter,
  fetchFrankfurterLatest,
  fetchOpenExchangeRates,
  latestRate,
  loadRates,
} from '../fx/service';
import {
  commitImport,
  discardImport,
  getImport,
  listImports,
  previewImport,
  undoImport,
} from '../imports/service';
import { attachReceipt, searchReceipts, splitByReceipt, uploadReceipt } from '../receipts/service';
import { addCashTransaction, createCashAccount } from '../services/cash';
import { loadDataset } from '../services/dataset';
import { editTransaction } from '../services/edits';
import { confirmLink, linkManually, listLinks, rejectLink } from '../services/links';
import { runTransferMatcher } from '../services/matcher';
import { runRules } from '../services/rules';
import { ensureDefaultCategories, loadDatasetIntoDb } from '../services/seed';
import { getSettings, updateSettings } from '../services/settings';
import { splitTransaction, undoSplit } from '../services/splits';
import { getTransaction, listTransactions } from '../services/transactions';
import { syncConnection } from '../sync/run';
import { registerEditRoutes } from './edits';
import { isPublicLinkCallback, registerLinkRoutes } from './link';
import { ApiError, badRequest, notFound } from '../util/errors';
import { newId, nowIso, safeEqual } from '../util/ids';

export interface AppDeps extends AiDeps {
  /** Outbound fetch for FX providers (tests pass a fake). */
  fetch?: typeof fetch;
  /** Clock for connector syncs and account-link sessions; defaults to real time. */
  now?: () => Date;
}

type AppEnv = { Bindings: Env; Variables: { deps: AppDeps } };

const money = z
  .number()
  .int()
  .refine((n) => Number.isSafeInteger(n), 'Must be whole minor units.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code.');

const patchSchema = z
  .object({
    name: z.string().min(1).max(200),
    date: isoDate,
    amount: money,
    categoryId: z.string().nullable(),
    merchantId: z.string().nullable(),
    kind: z.enum([
      'regular',
      'transfer',
      'card_payment',
      'loan_payment',
      'investment_contribution',
    ]),
    notes: z.string().max(2000).nullable(),
    tagIds: z.array(z.string()),
    excluded: z.boolean(),
    reviewed: z.boolean(),
  })
  .partial()
  .strict();

const splitSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  lines: z
    .array(
      z.object({
        amount: money,
        categoryId: z.string().nullable(),
        name: z.string().max(200).optional(),
        notes: z.string().max(2000).optional(),
        tagIds: z.array(z.string()).optional(),
        kind: z
          .enum(['regular', 'transfer', 'card_payment', 'loan_payment', 'investment_contribution'])
          .optional(),
      }),
    )
    .min(2)
    .max(50),
});

const cashSchema = z.object({
  amount: money,
  currency,
  categoryId: z.string().nullable().optional(),
  name: z.string().max(200).optional(),
  date: isoDate.optional(),
  notes: z.string().max(2000).nullable().optional(),
  accountId: z.string().optional(),
});

const conditionSchema = z.union([
  z.object({
    field: z.enum(['name', 'rawName']),
    op: z.enum(['contains', 'equals', 'starts_with', 'regex']),
    value: z.string().min(1).max(200),
    caseSensitive: z.boolean().optional(),
  }),
  z.object({ field: z.literal('amount'), op: z.enum(['equals', 'gt', 'lt']), value: money }),
  z.object({
    field: z.literal('amount'),
    op: z.literal('between'),
    value: z.tuple([money, money]),
  }),
  z.object({
    field: z.enum(['accountId', 'categoryId', 'currency']),
    op: z.enum(['equals', 'in']),
    value: z.union([z.string(), z.array(z.string())]),
  }),
]);
const actionSchema = z.union([
  z.object({ type: z.literal('set_category'), categoryId: z.string() }),
  z.object({ type: z.literal('set_name'), name: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('set_kind'),
    kind: z.enum([
      'regular',
      'transfer',
      'card_payment',
      'loan_payment',
      'investment_contribution',
    ]),
  }),
  z.object({ type: z.literal('add_tag'), tagId: z.string() }),
  z.object({ type: z.literal('mark_reviewed') }),
  z.object({ type: z.literal('exclude') }),
]);
const ruleSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).min(1).max(20),
  actions: z.array(actionSchema).min(1).max(10),
});

const policyValues = z
  .object({
    transfers: z.enum(['exclude', 'count']),
    cardPayments: z.enum(['exclude', 'count']),
    investmentContributions: z.enum(['exclude', 'count']),
    loanPrincipal: z.enum(['exclude', 'count']),
    refunds: z.enum(['reduce_category', 'count_as_income']),
    categoryFloor: z.enum(['none', 'zero']),
    pendingTransactions: z.enum(['include', 'exclude']),
  })
  .partial()
  .strict();

const settingsSchema = z
  .object({
    displayCurrencyMode: z.enum(DISPLAY_CURRENCY_MODES as [string, ...string[]]),
    primaryCurrency: currency,
    secondaryCurrency: currency,
    aiEnabled: z.boolean(),
    aiProvider: z.enum(['workers_ai', 'anthropic', 'openai', 'openai_compatible', 'gemini_paid']),
    look: z.enum(LOOKS as [string, ...string[]]),
    colorScheme: z.enum(['system', 'light', 'dark']),
    hapticsEnabled: z.boolean(),
    dashboardLayout: z.enum(['widgets', 'safe_to_spend']),
    moneyPolicies: policyValues,
    mcpWriteToolsEnabled: z.boolean(),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]),
  })
  .partial()
  .strict();

async function body<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest('Send a JSON body.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body.',
      'invalid_body',
    );
  }
  return parsed.data;
}

async function fileFrom(c: Context<AppEnv>): Promise<{ form: FormData; file: File }> {
  const type = c.req.header('content-type') ?? '';
  if (!type.includes('multipart/form-data'))
    throw badRequest('Send the file as multipart/form-data in a "file" field.');
  const form = await c.req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw badRequest('Missing the "file" field.');
  return { form, file };
}

/** The API under /v1. Bearer APP_API_TOKEN on every request; fails closed when the secret is missing. */
export function createApp(deps: AppDeps = {}) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.use('/v1/*', async (c, next) => {
    const origin = c.env.APP_ORIGIN ?? '*';
    return cors({
      origin: origin === '*' ? '*' : origin.split(',').map((o) => o.trim()),
      allowHeaders: ['authorization', 'content-type'],
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    })(c, next);
  });
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    // Provider redirects (Zerodha Kite...) arrive from the user's browser with no token; see api/link.ts.
    if (isPublicLinkCallback(new URL(c.req.url).pathname)) return next();
    const expected = c.env.APP_API_TOKEN;
    if (!expected)
      return c.json(
        { error: 'not_configured', message: 'Set the APP_API_TOKEN secret first.' },
        503,
      );
    const got = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!got || !safeEqual(got, expected))
      return c.json({ error: 'unauthorized', message: 'Missing or wrong API token.' }, 401);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ApiError)
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    // Provider trouble while linking or syncing: short messages that never carry a provider body or a credential.
    if (err instanceof LinkInputError)
      return c.json({ error: 'link_input', message: err.message }, 400);
    if (err instanceof ConnectorConfigError)
      return c.json({ error: 'not_configured', message: err.message }, 503);
    if (err instanceof ConnectorRateLimitedError)
      return c.json({ error: 'rate_limited', message: err.message }, 429);
    if (err instanceof ProviderHttpError) {
      const keys = err.status === 401 || err.status === 403;
      return c.json(
        {
          error: 'provider_error',
          message: keys
            ? `${err.provider} refused the request. Check the app's keys for ${err.provider} in GitHub secrets.`
            : `${err.provider} did not answer properly (HTTP ${err.status}). Try again in a minute.`,
        },
        502,
      );
    }
    if (err instanceof ProviderDataError)
      return c.json({ error: 'provider_error', message: err.message }, 502);
    if (err instanceof ConnectorRepairNeededError)
      return c.json({ error: 'needs_repair', message: err.message }, 409);
    if (err instanceof AiDisabledError)
      return c.json({ error: 'ai_disabled', message: err.message }, 409);
    if (err instanceof AiUnavailableError)
      return c.json({ error: 'ai_unavailable', message: err.message }, 503);
    // The name only: a message could quote input, and input may be a credential.
    console.error('Unhandled error', err instanceof Error ? err.name : 'unknown');
    return c.json({ error: 'internal', message: 'Something went wrong on the server.' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not_found', message: 'Not found.' }, 404));

  app.get('/health', async (c) => {
    const settings = c.env.DB ? await getSettings(c.env.DB).catch(() => null) : null;
    return c.json({
      ok: true,
      service: 'manaclaude-api',
      policies: settings?.moneyPolicies ?? null,
    });
  });

  // ---- Account-linking callbacks (public paths, built by session E2) ----
  registerLinkRoutes(app);
  registerEditRoutes(app);

  // ---- Dataset, accounts, transactions -----------------------------------
  app.get('/v1/dataset', async (c) => {
    await ensureDefaultCategories(c.env.DB);
    return c.json(await loadDataset(c.env.DB));
  });
  app.get('/v1/accounts', async (c) =>
    c.json({ accounts: await selectAll(c.env.DB, accountsTable, '', [], 'name') }),
  );
  app.post('/v1/accounts/cash', async (c) => {
    const b = await body(
      c,
      z.object({
        name: z.string().min(1).max(100),
        currency,
        balance: money.optional(),
        isDefault: z.boolean().optional(),
      }),
    );
    return c.json({ account: await createCashAccount(c.env.DB, b) }, 201);
  });

  app.get('/v1/transactions', async (c) => {
    const q = c.req.query();
    const transactions = await listTransactions(c.env.DB, {
      from: q.from,
      to: q.to,
      accountId: q.accountId,
      categoryId: q.categoryId,
      search: q.q,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    return c.json({ transactions });
  });
  app.get('/v1/transactions/:id', async (c) => {
    const t = await getTransaction(c.env.DB, c.req.param('id'));
    if (!t) throw notFound('Transaction not found.');
    return c.json({ transaction: t });
  });
  app.patch('/v1/transactions/:id', async (c) => {
    const patch = await body(c, patchSchema);
    return c.json({ transaction: await editTransaction(c.env.DB, c.req.param('id'), patch) });
  });
  app.post('/v1/transactions/:id/review', async (c) => {
    const b = await body(c, z.object({ reviewed: z.boolean() }));
    return c.json({
      transaction: await editTransaction(c.env.DB, c.req.param('id'), { reviewed: b.reviewed }),
    });
  });
  app.post('/v1/transactions/:id/category', async (c) => {
    const b = await body(c, z.object({ categoryId: z.string().nullable() }));
    return c.json({
      transaction: await editTransaction(c.env.DB, c.req.param('id'), { categoryId: b.categoryId }),
    });
  });
  app.post('/v1/transactions/:id/split', async (c) => {
    const b = await body(c, splitSchema);
    const res = await splitTransaction(c.env.DB, { parentTransactionId: c.req.param('id'), ...b });
    return c.json(res, res.replayed ? 200 : 201);
  });
  app.delete('/v1/transactions/:id/split', async (c) => {
    const parent = await undoSplit(c.env.DB, c.req.param('id'));
    return c.json({ parent, children: [], replayed: false });
  });
  app.post('/v1/transactions/:id/link', async (c) => {
    const b = await body(c, z.object({ otherTransactionId: z.string() }));
    return c.json(
      { link: await linkManually(c.env.DB, c.req.param('id'), b.otherTransactionId) },
      201,
    );
  });
  app.post('/v1/transactions/:id/unlink', async (c) => {
    const t = await getTransaction(c.env.DB, c.req.param('id'));
    if (!t) throw notFound('Transaction not found.');
    if (!t.transferLinkId) throw badRequest('This transaction is not linked.');
    return c.json({ link: await rejectLink(c.env.DB, t.transferLinkId) });
  });

  app.get('/v1/transfer-links', async (c) => {
    const status = c.req.query('status') as TransferLinkStatus | undefined;
    return c.json({ links: await listLinks(c.env.DB, status) });
  });
  app.post('/v1/transfer-links/run', async (c) => c.json(await runTransferMatcher(c.env.DB)));
  app.post('/v1/transfer-links/:id/confirm', async (c) =>
    c.json({ link: await confirmLink(c.env.DB, c.req.param('id')) }),
  );
  app.post('/v1/transfer-links/:id/reject', async (c) =>
    c.json({ link: await rejectLink(c.env.DB, c.req.param('id')) }),
  );

  app.post('/v1/cash', async (c) => {
    const b = await body(c, cashSchema);
    const transaction = await addCashTransaction(c.env.DB, { ...b, date: b.date ?? todayLocal() });
    return c.json({ transaction }, 201);
  });

  // ---- Categories and rules ------------------------------------------------
  app.get('/v1/categories', async (c) => {
    await ensureDefaultCategories(c.env.DB);
    return c.json({ categories: await selectAll(c.env.DB, categoriesTable, '', [], '"order"') });
  });
  app.post('/v1/categories', async (c) => {
    const b = await body(
      c,
      z.object({
        name: z.string().min(1).max(60),
        groupId: z.string(),
        kind: z.enum(['expense', 'income', 'transfer']),
        icon: z.string().default('circle'),
        color: z
          .string()
          .regex(/^c([1-9]|1[0-2])$/)
          .default('c1'),
        excludeFromBudget: z.boolean().default(false),
        order: z.number().int().optional(),
      }),
    );
    const category = { id: newId('cat'), archived: false, order: b.order ?? 999, ...b } as never;
    await insertStatement(c.env.DB, categoriesTable, category).run();
    return c.json({ category }, 201);
  });
  app.patch('/v1/categories/:id', async (c) => {
    const b = await body(
      c,
      z
        .object({
          name: z.string().min(1).max(60),
          archived: z.boolean(),
          excludeFromBudget: z.boolean(),
          order: z.number().int(),
        })
        .partial()
        .strict(),
    );
    const id = c.req.param('id');
    if (!(await selectOne(c.env.DB, categoriesTable, 'id = ?', [id])))
      throw notFound('Category not found.');
    if (Object.keys(b).length > 0)
      await updateStatement(c.env.DB, categoriesTable, { id }, b).run();
    return c.json({ category: await selectOne(c.env.DB, categoriesTable, 'id = ?', [id]) });
  });

  app.get('/v1/rules', async (c) =>
    c.json({ rules: await selectAll(c.env.DB, rulesTable, '', [], 'priority') }),
  );
  app.post('/v1/rules', async (c) => {
    const b = await body(c, ruleSchema);
    const now = nowIso();
    const rule: Rule = {
      id: newId('rule'),
      source: 'user',
      createdAt: now,
      updatedAt: now,
      ...b,
    } as Rule;
    await insertStatement(c.env.DB, rulesTable, rule).run();
    const applied = c.req.query('apply') === 'false' ? 0 : await runRules(c.env.DB);
    return c.json({ rule, applied }, 201);
  });
  app.put('/v1/rules/:id', async (c) => {
    const b = await body(c, ruleSchema);
    const id = c.req.param('id');
    const current = await selectOne(c.env.DB, rulesTable, 'id = ?', [id]);
    if (!current) throw notFound('Rule not found.');
    const rule = { ...current, ...b, updatedAt: nowIso() } as Rule;
    await insertStatement(c.env.DB, rulesTable, rule, 'upsert').run();
    return c.json({ rule, applied: await runRules(c.env.DB) });
  });
  app.delete('/v1/rules/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(c.req.param('id')).run();
    return c.body(null, 204);
  });
  app.post('/v1/rules/run', async (c) => c.json({ changed: await runRules(c.env.DB) }));

  // ---- Imports and the statement vault --------------------------------------
  app.post('/v1/imports', async (c) => {
    const { form, file } = await fileFrom(c);
    const format = (form.get('format') as string | null) || undefined;
    if (format && !IMPORT_FORMATS.includes(format as ImportFormat))
      throw badRequest('Unknown format.');
    let mapping: CsvMapping | undefined;
    const rawMapping = form.get('mapping');
    if (typeof rawMapping === 'string' && rawMapping) {
      try {
        mapping = JSON.parse(rawMapping) as CsvMapping;
      } catch {
        throw badRequest('mapping must be JSON.');
      }
    }
    let accountMappings: Record<string, string> | undefined;
    const rawAccounts = form.get('accountMappings');
    if (rawAccounts !== null) {
      try {
        accountMappings = z
          .record(z.string(), z.string().min(1))
          .parse(JSON.parse(String(rawAccounts)));
      } catch {
        throw badRequest(
          'accountMappings must be a JSON object mapping file account names to account IDs.',
        );
      }
    }
    const dayFirst = form.get('preferDayFirst');
    if (dayFirst !== null && dayFirst !== 'true' && dayFirst !== 'false')
      throw badRequest('preferDayFirst must be true or false.');
    const preview = await previewImport(
      c.env,
      {
        bytes: new Uint8Array(await file.arrayBuffer()),
        fileName: file.name || 'upload',
        contentType: file.type,
        format: format as ImportFormat | undefined,
        accountId: (form.get('accountId') as string | null) || undefined,
        mapping,
        accountMappings,
        currency: (form.get('currency') as string | null) || undefined,
        fromDate: (form.get('fromDate') as string | null) || undefined,
        toDate: (form.get('toDate') as string | null) || undefined,
        skipRows: form.get('skipRows') ? Number(form.get('skipRows')) : undefined,
        preferDayFirst: form.get('preferDayFirst')
          ? form.get('preferDayFirst') === 'true'
          : undefined,
      },
      c.get('deps'),
    );
    const wantCommit = form.get('commit') === 'true';
    if (wantCommit && preview.format === 'pdf')
      throw badRequest('PDF statements need a look at the preview first.');
    const result =
      wantCommit && preview.status === 'preview'
        ? await commitImport(c.env, preview.importId, {}, c.get('deps').now)
        : null;
    const res: ImportResponse = { preview, result };
    return c.json(res, 201);
  });
  app.get('/v1/imports', async (c) => c.json({ imports: await listImports(c.env.DB) }));
  app.get('/v1/imports/:id', async (c) => c.json(await getImport(c.env.DB, c.req.param('id'))));
  app.post('/v1/imports/:id/commit', async (c) => {
    const b = await body(
      c,
      z.object({
        skipLines: z.array(z.number().int()).optional(),
        keepLines: z.array(z.number().int().positive()).optional(),
        createAccounts: z.boolean().optional(),
      }),
    );
    return c.json(await commitImport(c.env, c.req.param('id'), b, c.get('deps').now));
  });
  app.post('/v1/imports/:id/discard', async (c) => {
    await discardImport(c.env.DB, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.delete('/v1/imports/:id/transactions', async (c) =>
    c.json({ removed: await undoImport(c.env.DB, c.req.param('id')) }),
  );
  app.get('/v1/import-mappings', async (c) => {
    const res = await c.env.DB.prepare(
      'SELECT signature, name, account_id, mapping, updated_at FROM import_mappings ORDER BY updated_at DESC',
    ).all<Record<string, string>>();
    return c.json({
      mappings: res.results.map((r) => ({
        signature: r.signature,
        name: r.name,
        accountId: r.account_id ?? null,
        mapping: JSON.parse(r.mapping!) as CsvMapping,
        updatedAt: r.updated_at,
      })),
    });
  });
  app.get('/v1/vault', async (c) => c.json({ files: await listImports(c.env.DB) }));
  app.get('/v1/vault/:id/file', async (c) => {
    const rec = await getImport(c.env.DB, c.req.param('id'));
    const obj = await c.env.FILES.get(rec.r2Key);
    if (!obj) throw notFound('The original file is missing from the vault.');
    return new Response(obj.body, {
      headers: {
        'content-type': rec.contentType,
        'content-disposition': `attachment; filename="${rec.fileName.replace(/["\\]/g, '_')}"`,
        'cache-control': 'private, no-store',
      },
    });
  });

  // ---- Receipts ---------------------------------------------------------------
  app.post('/v1/receipts', async (c) => {
    const { form, file } = await fileFrom(c);
    const res = await uploadReceipt(
      c.env,
      {
        bytes: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type,
        transactionId: (form.get('transactionId') as string | null) || undefined,
      },
      c.get('deps'),
    );
    return c.json(res, 201);
  });
  app.get('/v1/receipts', async (c) =>
    c.json({
      receipts: await searchReceipts(c.env.DB, {
        query: c.req.query('q'),
        from: c.req.query('from'),
        to: c.req.query('to'),
      }),
    }),
  );
  app.get('/v1/receipts/:id/image', async (c) => {
    const r = await selectOne(c.env.DB, receiptsTable, 'id = ?', [c.req.param('id')]);
    if (!r) throw notFound('Receipt not found.');
    const obj = await c.env.FILES.get(r.r2Key);
    if (!obj) throw notFound('Image missing.');
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg',
        'cache-control': 'private, max-age=3600',
      },
    });
  });
  app.post('/v1/receipts/:id/attach', async (c) => {
    const b = await body(c, z.object({ transactionId: z.string() }));
    return c.json({ receipt: await attachReceipt(c.env.DB, c.req.param('id'), b.transactionId) });
  });
  app.post('/v1/receipts/:id/split', async (c) => {
    const b = await body(c, z.object({ idempotencyKey: z.string().min(1) }));
    return c.json(await splitByReceipt(c.env.DB, c.req.param('id'), b.idempotencyKey), 201);
  });

  // ---- FX -------------------------------------------------------------------
  app.get('/v1/fx/latest', async (c) => {
    const base = (c.req.query('base') ?? 'USD').toUpperCase();
    const quote = (c.req.query('quote') ?? 'INR').toUpperCase();
    const r = await latestRate(c.env.DB, base, quote);
    const res: FxLatestResponse = {
      base,
      quote,
      rate: r?.rate ?? null,
      asOf: r?.asOf ?? null,
      source: r?.source ?? null,
    };
    return c.json(res);
  });
  app.get('/v1/fx/rates', async (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    const rates = (await loadRates(c.env.DB)).filter(
      (r) => (!from || r.date >= from) && (!to || r.date <= to),
    );
    return c.json({ rates });
  });
  app.post('/v1/fx/refresh', async (c) => {
    const f = c.get('deps').fetch;
    const oxr = await fetchOpenExchangeRates(c.env, f).catch(() => 0);
    const ecb = await fetchFrankfurterLatest(c.env, f).catch(() => 0);
    return c.json({ openExchangeRates: oxr, frankfurter: ecb });
  });
  app.post('/v1/fx/backfill', async (c) => {
    const b = await body(c, z.object({ from: isoDate, to: isoDate }));
    return c.json({ stored: await backfillFrankfurter(c.env, b.from, b.to, c.get('deps').fetch) });
  });

  // ---- Settings and AI --------------------------------------------------------
  app.get('/v1/settings', async (c) => c.json(await getSettings(c.env.DB)));
  app.patch('/v1/settings', async (c) => {
    const b = await body(c, settingsSchema);
    return c.json(await updateSettings(c.env.DB, b as never));
  });
  app.get('/v1/ai/status', async (c) => {
    const settings = await getSettings(c.env.DB);
    const usage = await c.env.DB.prepare(
      "SELECT calls FROM ai_usage WHERE day = ? AND provider = 'workers_ai'",
    )
      .bind(todayLocal())
      .first<{ calls: number }>();
    const res: AiStatusResponse = {
      enabled: settings.aiEnabled,
      provider: settings.aiProvider,
      configured: providerStatus(c.env),
      workersAiCallsToday: usage?.calls ?? 0,
      workersAiDailyLimit: Number(c.env.AI_DAILY_CALL_LIMIT ?? '300'),
    };
    return c.json(res);
  });
  app.post('/v1/ai/jobs/:job', async (c) => {
    const job = c.req.param('job') as JobName;
    if (!JOBS.includes(job)) throw badRequest(`Unknown job. Use one of: ${JOBS.join(', ')}.`);
    return c.json(await runJob(c.env, job, c.get('deps')));
  });
  app.post('/v1/ai/ask', async (c) => {
    const b = await body(c, z.object({ question: z.string().min(3).max(500) }));
    return c.json({ answer: await answerQuestion(c.env, b.question, c.get('deps')) });
  });
  app.get('/v1/alerts', async (c) => {
    const res = await c.env.DB.prepare(
      'SELECT * FROM alerts WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT 100',
    ).all<Record<string, string | number | null>>();
    return c.json({
      alerts: res.results.map((r) => ({
        id: r.id,
        type: r.type,
        transactionId: r.transaction_id,
        recurringId: r.recurring_id,
        message: r.message,
        amount: r.amount,
        currency: r.currency,
        createdAt: r.created_at,
        dismissedAt: r.dismissed_at,
      })),
    });
  });
  app.post('/v1/alerts/:id/dismiss', async (c) => {
    await c.env.DB.prepare('UPDATE alerts SET dismissed_at = ? WHERE id = ?')
      .bind(nowIso(), c.req.param('id'))
      .run();
    return c.json({ ok: true });
  });
  app.get('/v1/recaps', async (c) => {
    const q = c.req.query('kind') ?? c.req.query('period');
    const kind =
      q === 'weekly' || q === 'week'
        ? 'weekly'
        : q === 'monthly' || q === 'month'
          ? 'monthly'
          : undefined;
    return c.json({ recaps: await listRecaps(c.env.DB, kind) });
  });
  app.get('/v1/recurring', async (c) =>
    c.json({ recurring: await selectAll(c.env.DB, recurringTable) }),
  );

  // ---- Connector sync -------------------------------------------------------------
  app.get('/v1/connections', async (c) =>
    c.json({ connections: await selectAll(c.env.DB, connectionsTable) }),
  );
  // ?force=true syncs a connection that needs repair (right after it was repaired) or refreshes a property value early.
  app.post('/v1/connections/:id/sync', async (c) => {
    const report = await syncConnection(c.env, c.req.param('id'), {
      fetch: c.get('deps').fetch,
      now: c.get('deps').now,
      force: c.req.query('force') === 'true',
    });
    return c.json(report, report.outcome === 'error' ? 502 : 200);
  });

  // ---- MCP OAuth clients (fallback when an assistant can't self-register) ----
  app.post('/v1/mcp/clients', async (c) => {
    const b = await body(
      c,
      z.object({
        name: z.string().min(1).max(100),
        redirectUris: z.array(z.string().url()).min(1).max(5),
      }),
    );
    const oauth = c.env.OAUTH_PROVIDER;
    if (!oauth) throw new ApiError(503, 'not_configured', 'OAuth is not available.');
    const created = await oauth.createClient({
      clientName: b.name,
      redirectUris: b.redirectUris,
      tokenEndpointAuthMethod: 'client_secret_post',
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
    });
    // The secret is shown once; it is stored only as a hash.
    return c.json({ clientId: created.clientId, clientSecret: created.clientSecret ?? null }, 201);
  });

  // ---- Local development ----------------------------------------------------------
  app.post('/v1/dev/seed', async (c) => {
    if (c.env.ALLOW_SAMPLE_SEED !== 'true') throw notFound();
    const data = createSampleData();
    await loadDatasetIntoDb(c.env.DB, data);
    return c.json({ accounts: data.accounts.length, transactions: data.transactions.length }, 201);
  });

  return app;
}
