import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  answerSophtronJob,
  claimSimplefinSetupToken,
  createPlaidLinkToken,
  createSophtronLogin,
  exchangeKiteRequestToken,
  exchangePlaidPublicToken,
  kiteLoginUrl,
  listSnaptradeAuthorizations,
  registerSnaptradeUser,
  searchSophtronInstitutions,
  snaptradePortalUrl,
  startSophtronRefresh,
  type SnaptradeUser,
} from '@manaclaude/connectors';
import type {
  BrowserLinkResponse,
  LinkDoneResponse,
  PlaidLinkTokenResponse,
  SophtronLinkStatus,
} from '@manaclaude/shared';
import type { Env } from '../env';
import type { AppDeps } from './app';
import {
  ANDROID_PACKAGE,
  OWNER_CLIENT_ID,
  assertCanLink,
  checkKeys,
  finishLink,
  linkContext,
  linkOptions,
  loadConnectionFor,
  markRepaired,
  plaidEnabled,
  requireConfigured,
  requireCredentialsSecret,
} from '../link/service';
import {
  createSession,
  endSession,
  getSession,
  moveSession,
  sessionSecret,
  type LinkSession,
} from '../link/sessions';
import { safeReturnUrl, signState, verifyState, withParams } from '../link/state';
import { loadCredentials, saveCredentials } from '../sync/credentials';
import { selectAll } from '../db/table';
import { connectionsTable } from '../db/tables';
import { ApiError, badRequest, conflict, notFound } from '../util/errors';
import { newId } from '../util/ids';
import { sophtronStatus } from '../link/sophtron';
import { completeSnaptradeRepair, snaptradeRepairCredentials } from '../link/snaptrade';

/**
 * Account linking (session E2). Every route under /v1/link needs the bearer
 * token, except the two browser callbacks below: providers send the person's
 * browser back to them with no token, so each one proves the request with a
 * signed, expiring, single-use `state` (link/state.ts) and nothing else.
 *
 *   Zerodha Kite:  https://manaclaude-api.<subdomain>.workers.dev/v1/link/zerodha_kite/callback
 *   SnapTrade:     https://manaclaude-api.<subdomain>.workers.dev/v1/link/snaptrade/callback
 *
 * Rules every route follows: credentials go in once and are saved encrypted
 * with saveCredentials; no response and no log line ever contains one; a
 * provider error becomes a short message without the provider's body.
 */
export const RESERVED_LINK_CALLBACKS = [
  '/v1/link/zerodha_kite/callback',
  '/v1/link/snaptrade/callback',
] as const;

/** Matches the shape of a callback path (kept for other code); only the reserved ones are public. */
export const LINK_CALLBACK_PATTERN = /^\/v1\/link\/[a-z0-9_]+\/callback$/;

export function isPublicLinkCallback(path: string): boolean {
  return (RESERVED_LINK_CALLBACKS as readonly string[]).includes(path);
}

type AppEnv = { Bindings: Env; Variables: { deps: AppDeps } };
type C = Context<AppEnv>;

/** The SnapTrade user this app registers once, kept with the other saved logins. */
const SNAPTRADE_USER_KEY = 'app_snaptrade_user';
const KITE_MINUTES = 10;
const SESSION_MINUTES = 30;

const id = z
  .string()
  .regex(/^[a-z]+_[A-Za-z0-9]+$/)
  .max(80);
const optionalConnection = { connectionId: id.optional() };

async function parse<T extends z.ZodTypeAny>(c: C, schema: T): Promise<z.infer<T>> {
  let json: unknown = {};
  try {
    const text = await c.req.text();
    json = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw badRequest('Send a JSON body.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Only the field name and the rule; never the value that was sent.
    throw badRequest(
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body.',
      'invalid_body',
    );
  }
  return parsed.data;
}

const fetchOf = (c: C) => c.get('deps').fetch;
const nowOf = (c: C) => c.get('deps').now?.() ?? new Date();
const contextOf = (c: C, connectorId: string) =>
  linkContext(c.env, connectorId, fetchOf(c), {}, c.get('deps').now);

function publicUrl(env: Env): string {
  const base = env.PUBLIC_URL?.replace(/\/$/, '');
  if (!base || !/^https?:\/\//.test(base))
    throw new ApiError(503, 'not_configured', 'PUBLIC_URL is not set; run the deploy again.');
  return base;
}

/** A small page for the browser after a callback, when there is no app to return to. */
function page(c: C, status: 200 | 400, title: string, text: string): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Billionaire</title></head><body style="margin:0;padding:32px 20px;font-family:system-ui,sans-serif;background:#000814;color:#e6edf7"><h1 style="font-size:22px;margin:0 0 12px">${esc(title)}</h1><p style="font-size:16px;line-height:1.5;margin:0;color:#a9b4c7">${esc(text)}</p></body></html>`,
    status,
    { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  );
}

function backToApp(
  c: C,
  session: Pick<LinkSession, 'returnUrl'> | null,
  connector: string,
  ok: boolean,
  title: string,
  text: string,
): Response {
  const target = session?.returnUrl ? safeReturnUrl(c.env, session.returnUrl) : null;
  if (target) {
    return c.redirect(
      withParams(target, { link: connector, status: ok ? 'ok' : 'error', message: text }),
      302,
    );
  }
  return page(c, ok ? 200 : 400, title, text);
}

// ---------------------------------------------------------------------------
// Sophtron
// ---------------------------------------------------------------------------

const answerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('security_answer'),
    answers: z.array(z.string().trim().min(1).max(256)).min(1).max(10),
  }),
  z.object({ type: z.literal('token_choice'), choice: z.string().min(1).max(200) }),
  z.object({ type: z.literal('token_input'), code: z.string().trim().min(1).max(64) }),
  z.object({ type: z.literal('verify_phone') }),
  z.object({ type: z.literal('captcha'), text: z.string().trim().min(1).max(64) }),
]);

// ---------------------------------------------------------------------------
// SnapTrade
// ---------------------------------------------------------------------------

async function snaptradeUser(c: C): Promise<SnaptradeUser> {
  const saved = await loadCredentials(c.env, SNAPTRADE_USER_KEY);
  if (saved.SNAPTRADE_USER_ID && saved.SNAPTRADE_USER_SECRET) {
    return { userId: saved.SNAPTRADE_USER_ID, userSecret: saved.SNAPTRADE_USER_SECRET };
  }
  // A random id: SnapTrade only needs it to be unique for this app.
  const user = await registerSnaptradeUser(contextOf(c, 'snaptrade'), newId('billionaire'));
  await saveCredentials(
    c.env,
    SNAPTRADE_USER_KEY,
    { SNAPTRADE_USER_ID: user.userId, SNAPTRADE_USER_SECRET: user.userSecret },
    { replace: true },
  );
  return user;
}

/** Authorization ids already attached to a SnapTrade connection. */
async function linkedSnaptradeAuthorizations(env: Env): Promise<Map<string, string>> {
  const conns = await selectAll(env.DB, connectionsTable, "connector_id = 'snaptrade'");
  const out = new Map<string, string>();
  for (const conn of conns) {
    const creds = await loadCredentials(env, conn.id);
    if (creds.SNAPTRADE_AUTHORIZATION_ID) out.set(creds.SNAPTRADE_AUTHORIZATION_ID, conn.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerLinkRoutes<E extends AppEnv>(hono: Hono<E>): void {
  const app = hono as unknown as Hono<AppEnv>;

  app.get('/v1/link/options', async (c) => c.json(await linkOptions(c.env)));

  // ---- Sophtron: search, sign in, poll the job, answer the bank -------------
  app.post('/v1/link/sophtron/institutions', async (c) => {
    requireConfigured(c.env, 'sophtron');
    const b = await parse(c, z.object({ query: z.string().trim().min(2).max(100) }));
    const institutions = await searchSophtronInstitutions(contextOf(c, 'sophtron'), b.query);
    return c.json({ institutions });
  });

  app.post('/v1/link/sophtron/start', async (c) => {
    requireConfigured(c.env, 'sophtron');
    const b = await parse(
      c,
      z.object({
        institutionId: z.string().min(1).max(100).optional(),
        institutionName: z.string().min(1).max(120).optional(),
        username: z.string().min(1).max(200).optional(),
        password: z.string().min(1).max(500).optional(),
        pin: z.string().max(50).optional(),
        refresh: z.boolean().optional(),
        ...optionalConnection,
      }),
    );
    const ctx = contextOf(c, 'sophtron');
    let secret: Record<string, string>;
    let status: 'pending' | 'finalizing' = 'pending';
    let institutionName = b.institutionName ?? null;
    if (b.refresh) {
      if (!b.connectionId) throw badRequest('Say which connection to repair.');
      const conn = await loadConnectionFor(c.env.DB, b.connectionId, 'sophtron');
      institutionName = conn.institutionName;
      const creds = await loadCredentials(c.env, conn.id);
      if (!creds.SOPHTRON_USER_INSTITUTION_ID)
        throw conflict('This connection has no saved Sophtron login. Sign in again instead.');
      const job = await startSophtronRefresh(ctx, creds.SOPHTRON_USER_INSTITUTION_ID);
      status = job ? 'pending' : 'finalizing';
      secret = job ? { jobId: job.jobId } : {};
    } else {
      if (!b.institutionId || !b.username || !b.password)
        throw badRequest('Choose the bank and enter its user name and password.');
      if (b.connectionId) {
        const conn = await loadConnectionFor(c.env.DB, b.connectionId, 'sophtron');
        institutionName = institutionName ?? conn.institutionName;
      } else {
        await assertCanLink(c.env.DB, 'sophtron');
      }
      // The bank password goes to Sophtron here and nowhere else: it is not stored or logged.
      const login = await createSophtronLogin(ctx, {
        institutionId: b.institutionId,
        username: b.username,
        password: b.password,
        pin: b.pin,
      });
      secret = { jobId: login.jobId, userInstitutionId: login.userInstitutionId };
    }
    const session = await createSession(c.env, {
      now: nowOf(c),
      connectorId: 'sophtron',
      status,
      connectionId: b.connectionId ?? null,
      institutionName,
      minutes: SESSION_MINUTES,
      secret,
    });
    return c.json(await sophtronStatus(c.env, session, contextOf(c, 'sophtron'), () => nowOf(c)));
  });

  app.get('/v1/link/sophtron/:linkId', async (c) => {
    requireConfigured(c.env, 'sophtron');
    const session = await getSession(c.env, c.req.param('linkId'), 'sophtron', nowOf(c));
    if (!session) throw notFound('This sign-in has expired. Start again.');
    return c.json(await sophtronStatus(c.env, session, contextOf(c, 'sophtron'), () => nowOf(c)));
  });

  app.post('/v1/link/sophtron/:linkId/answer', async (c) => {
    requireConfigured(c.env, 'sophtron');
    const session = await getSession(c.env, c.req.param('linkId'), 'sophtron', nowOf(c));
    if (!session || session.status !== 'pending')
      throw notFound('This sign-in has expired. Start again.');
    const answer = await parse(c, answerSchema);
    const secret = await sessionSecret(c.env, session.id);
    if (!secret.jobId) throw notFound('This sign-in has expired. Start again.');
    await answerSophtronJob(contextOf(c, 'sophtron'), secret.jobId, answer);
    return c.json({ linkId: session.id, status: 'pending' } satisfies SophtronLinkStatus);
  });

  // ---- SimpleFIN: claim the setup token for the access URL ------------------
  app.post('/v1/link/simplefin', async (c) => {
    requireCredentialsSecret(c.env);
    const b = await parse(
      c,
      z.object({ setupToken: z.string().trim().min(20).max(2000), ...optionalConnection }),
    );
    if (b.connectionId) await loadConnectionFor(c.env.DB, b.connectionId, 'simplefin');
    else await assertCanLink(c.env.DB, 'simplefin');
    const accessUrl = await claimSimplefinSetupToken(contextOf(c, 'simplefin'), b.setupToken);
    const done = await finishLink(c.env, {
      now: nowOf(c),
      connectorId: 'simplefin',
      institutionName: 'SimpleFIN',
      credentials: { SIMPLEFIN_ACCESS_URL: accessUrl },
      connectionId: b.connectionId,
    });
    return c.json(
      { connectionIds: [done.connectionId], repaired: done.repaired } satisfies LinkDoneResponse,
      201,
    );
  });

  // ---- SnapTrade: register the user, open the portal, record the authorization
  app.post('/v1/link/snaptrade/start', async (c) => {
    requireConfigured(c.env, 'snaptrade');
    const b = await parse(
      c,
      z.object({ returnUrl: z.string().max(500).optional(), ...optionalConnection }),
    );
    let reconnect: string | undefined;
    let repairCredentials: Record<string, string> | undefined;
    if (b.connectionId) {
      const conn = await loadConnectionFor(c.env.DB, b.connectionId, 'snaptrade');
      repairCredentials = await snaptradeRepairCredentials(c.env, conn.id);
      reconnect = repairCredentials.SNAPTRADE_AUTHORIZATION_ID;
    } else {
      await assertCanLink(c.env.DB, 'snaptrade');
    }
    const user = repairCredentials
      ? {
          userId: repairCredentials.SNAPTRADE_USER_ID!,
          userSecret: repairCredentials.SNAPTRADE_USER_SECRET!,
        }
      : await snaptradeUser(c);
    const session = await createSession(c.env, {
      now: nowOf(c),
      connectorId: 'snaptrade',
      secret: repairCredentials,
      connectionId: b.connectionId ?? null,
      returnUrl: safeReturnUrl(c.env, b.returnUrl),
      minutes: SESSION_MINUTES,
    });
    const state = await signState(c.env, session.id, new Date(session.expiresAt));
    const callback = withParams(`${publicUrl(c.env)}/v1/link/snaptrade/callback`, { state });
    const url = await snaptradePortalUrl(contextOf(c, 'snaptrade'), user, {
      customRedirect: callback,
      reconnect,
    });
    return c.json({ linkId: session.id, url } satisfies BrowserLinkResponse);
  });

  app.get('/v1/link/snaptrade/callback', async (c) => {
    const linkId = await verifyState(c.env, c.req.query('state'), nowOf(c));
    const session = linkId ? await getSession(c.env, linkId, 'snaptrade', nowOf(c)) : null;
    if (!session) {
      return page(c, 400, 'This link has expired', 'Go back to Billionaire and start again.');
    }
    await moveSession(c.env, session.id, ['pending'], 'returned', nowOf(c));
    return backToApp(
      c,
      session,
      'snaptrade',
      true,
      'Brokerage connected',
      'Go back to Billionaire and tap Done to finish.',
    );
  });

  app.post('/v1/link/snaptrade/:linkId/complete', async (c) => {
    requireConfigured(c.env, 'snaptrade');
    const session = await getSession(c.env, c.req.param('linkId'), 'snaptrade', nowOf(c));
    if (!session || session.status === 'done' || session.status === 'failed')
      throw notFound('This link has expired. Start again.');
    if (session.connectionId) {
      return c.json(
        await completeSnaptradeRepair(c.env, session, contextOf(c, 'snaptrade'), () => nowOf(c)),
      );
    }
    const user = await snaptradeUser(c);
    const auths = await listSnaptradeAuthorizations(contextOf(c, 'snaptrade'), user);
    const linked = await linkedSnaptradeAuthorizations(c.env);
    const fresh = auths.filter((a) => !a.disabled && !linked.has(a.id));
    if (fresh.length === 0) {
      throw conflict(
        'No new brokerage found yet. Finish connecting in the SnapTrade window, then tap Done again.',
        'not_finished',
      );
    }
    await assertCanLink(c.env.DB, 'snaptrade', fresh.length);
    if (!(await moveSession(c.env, session.id, ['pending', 'returned'], 'done', nowOf(c))))
      throw conflict('This link was already finished.');
    const ids: string[] = [];
    for (const a of fresh) {
      const done = await finishLink(c.env, {
        now: nowOf(c),
        connectorId: 'snaptrade',
        institutionName: a.name,
        credentials: {
          SNAPTRADE_USER_ID: user.userId,
          SNAPTRADE_USER_SECRET: user.userSecret,
          SNAPTRADE_AUTHORIZATION_ID: a.id,
        },
      });
      ids.push(done.connectionId);
    }
    await endSession(c.env, session.id, 'done', nowOf(c));
    return c.json({ connectionIds: ids, repaired: false } satisfies LinkDoneResponse, 201);
  });

  // ---- Zerodha Kite: login redirect with a signed state, daily re-login ---------
  app.post('/v1/link/zerodha_kite/start', async (c) => {
    requireConfigured(c.env, 'zerodha_kite');
    const b = await parse(
      c,
      z.object({ returnUrl: z.string().max(500).optional(), ...optionalConnection }),
    );
    // Kite allows one login per person, so an existing Zerodha connection is re-logged in, never doubled.
    let connectionId = b.connectionId ?? null;
    if (connectionId) await loadConnectionFor(c.env.DB, connectionId, 'zerodha_kite');
    else {
      const existing = await selectAll(c.env.DB, connectionsTable, "connector_id = 'zerodha_kite'");
      connectionId = existing[0]?.id ?? null;
      if (!connectionId) await assertCanLink(c.env.DB, 'zerodha_kite');
    }
    const session = await createSession(c.env, {
      now: nowOf(c),
      connectorId: 'zerodha_kite',
      connectionId,
      institutionName: 'Zerodha',
      returnUrl: safeReturnUrl(c.env, b.returnUrl),
      minutes: KITE_MINUTES,
    });
    const state = await signState(c.env, session.id, new Date(session.expiresAt));
    const apiKey = contextOf(c, 'zerodha_kite').secrets.KITE_API_KEY ?? '';
    return c.json({
      linkId: session.id,
      url: kiteLoginUrl(apiKey, state),
    } satisfies BrowserLinkResponse);
  });

  app.get('/v1/link/zerodha_kite/callback', async (c) => {
    const now = nowOf(c);
    const linkId = await verifyState(c.env, c.req.query('state'), now);
    const session = linkId ? await getSession(c.env, linkId, 'zerodha_kite', now) : null;
    if (!session) {
      return page(
        c,
        400,
        'This login link has expired',
        'Go back to Billionaire and tap Reconnect again.',
      );
    }
    const requestToken = c.req.query('request_token');
    if (c.req.query('status') !== 'success' || !requestToken || requestToken.length > 200) {
      await endSession(c.env, session.id, 'failed', now);
      return backToApp(
        c,
        session,
        'zerodha_kite',
        false,
        'Zerodha login was cancelled',
        'Nothing changed. Try again from Billionaire.',
      );
    }
    // Single use: a replayed callback finds the session already taken.
    if (!(await moveSession(c.env, session.id, ['pending'], 'returned', now))) {
      return page(c, 400, 'This login link was already used', 'Go back to Billionaire.');
    }
    try {
      requireConfigured(c.env, 'zerodha_kite');
      const accessToken = await exchangeKiteRequestToken(
        contextOf(c, 'zerodha_kite'),
        requestToken,
      );
      await finishLink(c.env, {
        now: nowOf(c),
        connectorId: 'zerodha_kite',
        institutionName: 'Zerodha',
        credentials: { KITE_ACCESS_TOKEN: accessToken },
        connectionId: session.connectionId,
      });
      await endSession(c.env, session.id, 'done', now);
      return backToApp(
        c,
        session,
        'zerodha_kite',
        true,
        'Zerodha is connected',
        'Go back to Billionaire. It syncs in a moment.',
      );
    } catch (e) {
      await endSession(c.env, session.id, 'failed', now);
      const message =
        e instanceof ApiError
          ? e.message
          : 'Zerodha did not finish the login. Try again from Billionaire.';
      console.error('Zerodha login failed', e instanceof Error ? e.name : 'error');
      return backToApp(c, session, 'zerodha_kite', false, 'Zerodha login failed', message);
    }
  });

  // ---- Plaid: link token, Plaid Link, public token exchange (off until enabled) ---
  const requirePlaid = (c: C) => {
    if (!plaidEnabled(c.env))
      throw conflict('Plaid is off until you say so. Nothing was sent to Plaid.', 'plaid_off');
    requireConfigured(c.env, 'plaid');
  };

  app.post('/v1/link/plaid/link-token', async (c) => {
    requirePlaid(c);
    const b = await parse(
      c,
      z.object({ platform: z.enum(['android', 'ios', 'web']), ...optionalConnection }),
    );
    let accessToken: string | undefined;
    if (b.connectionId) {
      await loadConnectionFor(c.env.DB, b.connectionId, 'plaid');
      accessToken = (await loadCredentials(c.env, b.connectionId)).PLAID_ACCESS_TOKEN;
      if (!accessToken) throw conflict('This connection has no saved Plaid login.');
    } else {
      await assertCanLink(c.env.DB, 'plaid');
    }
    const token = await createPlaidLinkToken(contextOf(c, 'plaid'), {
      clientUserId: OWNER_CLIENT_ID,
      platform: b.platform,
      androidPackageName: ANDROID_PACKAGE,
      redirectUri: c.env.PLAID_REDIRECT_URI,
      accessToken,
    });
    return c.json(token satisfies PlaidLinkTokenResponse);
  });

  app.post('/v1/link/plaid/exchange', async (c) => {
    requirePlaid(c);
    const b = await parse(
      c,
      z.object({
        publicToken: z.string().min(10).max(500).optional(),
        institutionName: z.string().min(1).max(120).optional(),
        ...optionalConnection,
      }),
    );
    if (!b.publicToken) {
      if (!b.connectionId) throw badRequest('Send the public token from Plaid Link.');
      const done = await markRepaired(c.env, b.connectionId, 'plaid', nowOf(c));
      return c.json({
        connectionIds: [done.connectionId],
        repaired: true,
      } satisfies LinkDoneResponse);
    }
    if (!b.connectionId) await assertCanLink(c.env.DB, 'plaid');
    const exchanged = await exchangePlaidPublicToken(contextOf(c, 'plaid'), b.publicToken);
    const done = await finishLink(c.env, {
      now: nowOf(c),
      connectorId: 'plaid',
      institutionName: b.institutionName ?? 'Bank (Plaid)',
      credentials: { PLAID_ACCESS_TOKEN: exchanged.accessToken, PLAID_ITEM_ID: exchanged.itemId },
      connectionId: b.connectionId,
    });
    return c.json(
      { connectionIds: [done.connectionId], repaired: done.repaired } satisfies LinkDoneResponse,
      201,
    );
  });

  // ---- Coinbase and WazirX: read-only API keys ---------------------------------
  app.post('/v1/link/keys', async (c) => {
    requireCredentialsSecret(c.env);
    const b = await parse(
      c,
      z.object({
        connectorId: z.enum(['coinbase', 'wazirx']),
        apiKey: z.string().trim().min(8).max(500),
        apiSecret: z.string().trim().min(8).max(5000),
        ...optionalConnection,
      }),
    );
    if (b.connectionId) await loadConnectionFor(c.env.DB, b.connectionId, b.connectorId);
    else await assertCanLink(c.env.DB, b.connectorId);
    const prefix = b.connectorId === 'coinbase' ? 'COINBASE' : 'WAZIRX';
    const credentials = { [`${prefix}_API_KEY`]: b.apiKey, [`${prefix}_API_SECRET`]: b.apiSecret };
    await checkKeys(c.env, b.connectorId, credentials, fetchOf(c), c.get('deps').now);
    const done = await finishLink(c.env, {
      now: nowOf(c),
      connectorId: b.connectorId,
      institutionName: b.connectorId === 'coinbase' ? 'Coinbase' : 'WazirX',
      credentials,
      connectionId: b.connectionId,
    });
    return c.json(
      { connectionIds: [done.connectionId], repaired: done.repaired } satisfies LinkDoneResponse,
      201,
    );
  });
}
