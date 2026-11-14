import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  answerSophtronJob,
  claimSimplefinSetupToken,
  createPlaidLinkToken,
  createSophtronLogin,
  decodeSetupToken,
  exchangePlaidPublicToken,
  getSophtronJob,
  kiteLoginUrl,
  listSnaptradeAuthorizations,
  readSophtronJob,
  registerSnaptradeUser,
  searchSophtronInstitutions,
  snaptradePortalUrl,
} from '../src/link';
import { LinkInputError, ProviderHttpError } from '../src/errors';
import { fakeFetch, makeCtx } from './helpers/fakeFetch';

// Every key, token and password below is invented for the tests.
const SOPH = {
  SOPHTRON_USER_ID: 'demo-user-0001',
  SOPHTRON_ACCESS_KEY: Buffer.from('demo-sophtron-access-key-0123456').toString('base64'),
};
const H = 'api.sophtron.com';

describe('Sophtron linking', () => {
  it('searches institutions and reads either spelling of the fields', async () => {
    const fetch = fakeFetch({
      [`POST ${H}/api/Institution/GetInstitutionByName`]: {
        json: {
          Institutions: [
            { InstitutionID: 'inst-1', InstitutionName: 'Lakeview Bank', URL: 'lakeview.example' },
            { institution_id: 'inst-2', institution_name: 'Ridgeline Card Co' },
            { InstitutionName: 'No id' },
          ],
        },
      },
    });
    const list = await searchSophtronInstitutions(makeCtx(SOPH, fetch), 'lake');
    expect(list).toEqual([
      { id: 'inst-1', name: 'Lakeview Bank', url: 'lakeview.example' },
      { id: 'inst-2', name: 'Ridgeline Card Co', url: null },
    ]);
    expect(JSON.parse(fetch.calls[0]?.body ?? '{}')).toEqual({ InstitutionName: 'lake' });
    const expected = createHmac('sha256', Buffer.from(SOPH.SOPHTRON_ACCESS_KEY, 'base64'))
      .update('POST\n/getinstitutionbyname')
      .digest('base64');
    expect(fetch.calls[0]?.headers.Authorization).toBe(
      `FIApiAUTH:demo-user-0001:${expected}:/getinstitutionbyname`,
    );
  });

  it('creates the login with the app user id and returns the job and login ids', async () => {
    const fetch = fakeFetch({
      [`POST ${H}/api/UserInstitution/CreateUserInstitution`]: {
        json: { JobID: 'job-1', UserInstitutionID: 'ui-9' },
      },
    });
    const out = await createSophtronLogin(makeCtx(SOPH, fetch), {
      institutionId: 'inst-1',
      username: 'demo-bank-user',
      password: 'demo-bank-password',
    });
    expect(out).toEqual({ jobId: 'job-1', userInstitutionId: 'ui-9' });
    expect(JSON.parse(fetch.calls[0]?.body ?? '{}')).toEqual({
      UserID: 'demo-user-0001',
      InstitutionID: 'inst-1',
      UserName: 'demo-bank-user',
      Password: 'demo-bank-password',
      PIN: '',
    });
  });

  it('reads job states in the same order as Sure', () => {
    expect(readSophtronJob({ SuccessFlag: true })).toEqual({ state: 'success' });
    expect(readSophtronJob({ LastStatus: 'AccountsReady' })).toEqual({ state: 'success' });
    expect(readSophtronJob({ LastStatus: 'Completed' })).toEqual({ state: 'success' });
    expect(readSophtronJob({ LastStatus: 'Completed', SuccessFlag: false }).state).toBe('failed');
    expect(readSophtronJob({ LastStatus: 'Timeout', SuccessFlag: false })).toMatchObject({
      state: 'failed',
      reason: expect.stringMatching(/too long/),
    });
    expect(readSophtronJob({ LastStatus: 'Started' })).toEqual({ state: 'pending' });
    expect(
      readSophtronJob({ SecurityQuestion: '["First pet?","First street?"]', SuccessFlag: false }),
    ).toEqual({
      state: 'mfa',
      challenge: {
        securityQuestions: ['First pet?', 'First street?'],
        tokenMethods: [],
        tokenSent: false,
        tokenRead: null,
        captchaImage: null,
      },
    });
    expect(readSophtronJob({ TokenMethod: '["Text ***-1234","Email"]' })).toMatchObject({
      challenge: { tokenMethods: ['Text ***-1234', 'Email'] },
    });
    expect(readSophtronJob({ TokenSentFlag: true })).toMatchObject({
      challenge: { tokenSent: true },
    });
    expect(readSophtronJob({ CaptchaImage: 'iVBORw0KGgo="><script>' })).toMatchObject({
      challenge: { captchaImage: 'iVBORw0KGgo=' },
    });
  });

  it('polls the job and sends each kind of answer to its endpoint', async () => {
    const fetch = fakeFetch({
      [`POST ${H}/api/Job/GetJobInformationByID`]: { json: { TokenSentFlag: true } },
      [`POST ${H}/api/Job/UpdateJobSecurityAnswer`]: { json: {} },
      [`POST ${H}/api/Job/UpdateJobTokenInput`]: { json: {} },
      [`POST ${H}/api/Job/UpdateJobCaptcha`]: { json: {} },
    });
    const ctx = makeCtx(SOPH, fetch);
    expect((await getSophtronJob(ctx, 'job-1')).state).toBe('mfa');
    await answerSophtronJob(ctx, 'job-1', { type: 'security_answer', answers: ['Rex'] });
    await answerSophtronJob(ctx, 'job-1', { type: 'token_choice', choice: 'Email' });
    await answerSophtronJob(ctx, 'job-1', { type: 'token_input', code: '123456' });
    await answerSophtronJob(ctx, 'job-1', { type: 'verify_phone' });
    await answerSophtronJob(ctx, 'job-1', { type: 'captcha', text: 'ab12' });
    const bodies = fetch.calls.slice(1).map((c) => [c.url.pathname, JSON.parse(c.body ?? '{}')]);
    expect(bodies).toEqual([
      ['/api/Job/UpdateJobSecurityAnswer', { JobID: 'job-1', SecurityAnswer: '["Rex"]' }],
      [
        '/api/Job/UpdateJobTokenInput',
        { JobID: 'job-1', TokenChoice: 'Email', TokenInput: null, VerifyPhoneFlag: null },
      ],
      [
        '/api/Job/UpdateJobTokenInput',
        { JobID: 'job-1', TokenChoice: null, TokenInput: '123456', VerifyPhoneFlag: null },
      ],
      [
        '/api/Job/UpdateJobTokenInput',
        { JobID: 'job-1', TokenChoice: null, TokenInput: null, VerifyPhoneFlag: true },
      ],
      ['/api/Job/UpdateJobCaptcha', { JobID: 'job-1', CaptchaInput: 'ab12' }],
    ]);
  });

  it('a 401 while linking means the app keys are wrong, not a login to repair', async () => {
    const fetch = fakeFetch({
      [`POST ${H}/api/Institution/GetInstitutionByName`]: { status: 401, json: {} },
    });
    await expect(searchSophtronInstitutions(makeCtx(SOPH, fetch), 'x')).rejects.toBeInstanceOf(
      ProviderHttpError,
    );
  });
});

describe('SimpleFIN setup token', () => {
  const claimUrl = 'https://bridge.example.invalid/simplefin/claim/demo-claim-0001';
  const token = btoa(claimUrl);
  const accessUrl = 'https://demo-user:demo-pass@bridge.example.invalid/simplefin';

  it('claims the token with an empty POST and returns the access URL', async () => {
    const fetch = fakeFetch({
      'POST bridge.example.invalid/simplefin/claim/demo-claim-0001': { text: `${accessUrl}\n` },
    });
    expect(await claimSimplefinSetupToken(makeCtx({}, fetch), ` ${token} `)).toBe(accessUrl);
    expect(fetch.calls[0]).toMatchObject({ method: 'POST', body: '' });
  });

  it('explains a token that was already used', async () => {
    const fetch = fakeFetch({
      'POST bridge.example.invalid/simplefin/claim/demo-claim-0001': { status: 403, text: '' },
    });
    await expect(claimSimplefinSetupToken(makeCtx({}, fetch), token)).rejects.toThrow(
      /already used or has expired/,
    );
  });

  it('refuses text that is not a setup token, and plain-http claim URLs', () => {
    expect(() => decodeSetupToken('hello there')).toThrow(LinkInputError);
    expect(() => decodeSetupToken(btoa('http://bridge.example.invalid/claim/x'))).toThrow(
      LinkInputError,
    );
    expect(decodeSetupToken(token)).toBe(claimUrl);
  });

  it('refuses an answer that is not an access URL', async () => {
    const fetch = fakeFetch({
      'POST bridge.example.invalid/simplefin/claim/demo-claim-0001': { text: 'oops' },
    });
    await expect(claimSimplefinSetupToken(makeCtx({}, fetch), token)).rejects.toBeInstanceOf(
      LinkInputError,
    );
  });
});

describe('SnapTrade linking', () => {
  const ST = { SNAPTRADE_CLIENT_ID: 'DEMO-CLIENT', SNAPTRADE_CONSUMER_KEY: 'demo-consumer-key' };
  const user = { userId: 'billionaire-demo', userSecret: 'demo-user-secret' };

  it('requires an explicit disabled:false and rejects malformed authorization lists', async () => {
    for (const disabled of [undefined, null, true, 0, 'false', false]) {
      const fetch = fakeFetch({
        'GET api.snaptrade.com/api/v1/authorizations': {
          json: [{ id: 'invented-auth', disabled }],
        },
      });
      expect((await listSnaptradeAuthorizations(makeCtx(ST, fetch), user))[0]?.disabled).toBe(
        disabled !== false,
      );
    }
    const fetch = fakeFetch({ 'GET api.snaptrade.com/api/v1/authorizations': { json: [null] } });
    await expect(listSnaptradeAuthorizations(makeCtx(ST, fetch), user)).rejects.toThrow(
      /authorizations/,
    );
  });

  it('registers the user, opens the portal and lists authorizations, all signed', async () => {
    const fetch = fakeFetch({
      'POST api.snaptrade.com/api/v1/snapTrade/registerUser': { json: user },
      'POST api.snaptrade.com/api/v1/snapTrade/login': {
        json: { redirectURI: 'https://app.snaptrade.example/portal?session=demo', sessionId: 's' },
      },
      'GET api.snaptrade.com/api/v1/authorizations': {
        json: [
          { id: 'auth-1', brokerage: { name: 'Robinhood' }, disabled: false },
          { id: 'auth-2', brokerage: { display_name: 'Zerodha' }, disabled: true },
        ],
      },
    });
    const ctx = makeCtx(ST, fetch);
    expect(await registerSnaptradeUser(ctx, 'billionaire-demo')).toEqual(user);
    expect(
      await snaptradePortalUrl(ctx, user, {
        customRedirect: 'https://api.example/v1/link/snaptrade/callback?state=x',
        reconnect: 'auth-1',
      }),
    ).toBe('https://app.snaptrade.example/portal?session=demo');
    expect(await listSnaptradeAuthorizations(ctx, user)).toEqual([
      { id: 'auth-1', name: 'Robinhood', disabled: false },
      { id: 'auth-2', name: 'Zerodha', disabled: true },
    ]);
    const [reg, login, list] = fetch.calls;
    expect(reg?.url.searchParams.get('clientId')).toBe('DEMO-CLIENT');
    expect(reg?.url.searchParams.get('userSecret')).toBeNull();
    expect(JSON.parse(login?.body ?? '{}')).toMatchObject({
      connectionType: 'read',
      reconnect: 'auth-1',
    });
    expect(login?.url.searchParams.get('userId')).toBe('billionaire-demo');
    for (const c of [reg, login, list]) expect(c?.headers.Signature).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('Plaid linking (invented responses only)', () => {
  const PL = { PLAID_CLIENT_ID: 'demo-client', PLAID_SECRET: 'demo-secret', PLAID_ENV: 'sandbox' };

  it('creates a link token for Android with the package name, and for update mode', async () => {
    const fetch = fakeFetch({
      'POST sandbox.plaid.com/link/token/create': {
        json: { link_token: 'link-sandbox-demo', expiration: '2026-11-05T16:00:00Z' },
      },
    });
    const ctx = makeCtx(PL, fetch);
    expect(
      await createPlaidLinkToken(ctx, {
        clientUserId: 'billionaire-owner',
        platform: 'android',
        androidPackageName: 'com.reddyai.manaclaude',
      }),
    ).toEqual({ linkToken: 'link-sandbox-demo', expiration: '2026-11-05T16:00:00Z' });
    const first = JSON.parse(fetch.calls[0]?.body ?? '{}');
    expect(first).toMatchObject({
      client_name: 'Billionaire',
      products: ['transactions'],
      android_package_name: 'com.reddyai.manaclaude',
      transactions: { days_requested: 730 },
    });
    await createPlaidLinkToken(ctx, {
      clientUserId: 'billionaire-owner',
      platform: 'web',
      accessToken: 'access-sandbox-demo',
    });
    const second = JSON.parse(fetch.calls[1]?.body ?? '{}');
    expect(second.access_token).toBe('access-sandbox-demo');
    expect(second.products).toBeUndefined();
    expect(fetch.calls[0]?.headers['PLAID-CLIENT-ID']).toBe('demo-client');
  });

  it('exchanges the public token', async () => {
    const fetch = fakeFetch({
      'POST production.plaid.com/item/public_token/exchange': {
        json: { access_token: 'access-demo-1', item_id: 'item-demo-1' },
      },
    });
    const out = await exchangePlaidPublicToken(
      makeCtx({ ...PL, PLAID_ENV: 'production' }, fetch),
      'public-demo-1',
    );
    expect(out).toEqual({ accessToken: 'access-demo-1', itemId: 'item-demo-1' });
  });
});

describe('Kite login URL', () => {
  it('carries the api key and the signed state through redirect_params', () => {
    const url = new URL(kiteLoginUrl('demo_api_key', 'abc.def'));
    expect(url.origin + url.pathname).toBe('https://kite.zerodha.com/connect/login');
    expect(url.searchParams.get('v')).toBe('3');
    expect(url.searchParams.get('api_key')).toBe('demo_api_key');
    expect(new URLSearchParams(url.searchParams.get('redirect_params') ?? '').get('state')).toBe(
      'abc.def',
    );
  });
});
