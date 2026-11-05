import { describe, expect, it } from 'vitest';
import type { ConnectorContext, SocketLike } from '@manaclaude/shared';
import { ConnectorRepairNeededError } from '@manaclaude/shared';
import { TRADE_REPUBLIC_WS, tradeRepublicAdapter } from '../src/adapters/trade_republic';
import { ConnectorConfigError } from '../src/errors';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import { expectRepeatSyncIsQuiet, expectSyncShape } from './helpers/contract';

type Reply = unknown | ((payload: Record<string, unknown>) => string);

/** A scripted Trade Republic socket: answers "sub <id> <json>" by topic. */
function fakeSocket(
  topics: Record<string, Reply>,
  opts: { error?: string; noConnected?: boolean } = {},
) {
  const sent: string[] = [];
  let onMessage: (t: string) => void = () => {};
  let onClose: () => void = () => {};
  let closed = false;
  const socket: SocketLike = {
    send(text) {
      sent.push(text);
      queueMicrotask(() => {
        if (text.startsWith('connect ')) {
          if (!opts.noConnected) onMessage('connected');
          return;
        }
        const m = /^sub (\d+) (.*)$/.exec(text);
        if (!m) return;
        const id = m[1];
        const payload = JSON.parse(m[2] as string) as Record<string, unknown>;
        if (opts.error) return onMessage(`${id} E ${opts.error}`);
        const key =
          payload.type === 'ticker'
            ? `ticker:${String(payload.id).split('.')[0]}`
            : payload.type === 'timelineTransactions' && payload.after
              ? `timelineTransactions:${String(payload.after)}`
              : String(payload.type);
        const reply = topics[key];
        if (reply === undefined)
          return onMessage(`${id} E {"errors":[{"errorCode":"UNKNOWN_TOPIC"}]}`);
        onMessage(
          `${id} A ${typeof reply === 'function' ? (reply as (p: Record<string, unknown>) => string)(payload) : JSON.stringify(reply)}`,
        );
      });
    },
    onMessage(h) {
      onMessage = h;
    },
    onClose(h) {
      onClose = h;
    },
    close() {
      closed = true;
      onClose();
    },
  };
  return { socket, sent, isClosed: () => closed };
}

const TOPICS = {
  compactPortfolio: fixture('trade_republic', 'portfolio.json'),
  cash: fixture('trade_republic', 'cash.json'),
  'ticker:IE00BK5BQT80': fixture('trade_republic', 'ticker_world.json'),
  'ticker:US0000000001': fixture('trade_republic', 'ticker_us.json'),
  timelineTransactions: fixture('trade_republic', 'timeline_page1.json'),
  'timelineTransactions:cursor-2': fixture('trade_republic', 'timeline_page2.json'),
};
const SECRETS = { TRADEREPUBLIC_SESSION: 'tr_session=demo-cookie' };

function ctxWith(
  script: ReturnType<typeof fakeSocket>,
  secrets: Record<string, string> = SECRETS,
): ConnectorContext & { urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const base = makeCtx(secrets, fakeFetch({}));
  return Object.assign(base, {
    urls,
    headers,
    connectSocket: async (url: string, h?: Record<string, string>) => {
      urls.push(url);
      headers.push(h ?? {});
      return script.socket;
    },
  });
}
const freshCtx = () => ctxWith(fakeSocket(TOPICS));

describe('trade republic adapter (experimental)', () => {
  it('opens the socket with the stored session cookie and speaks the connect handshake', async () => {
    const script = fakeSocket(TOPICS);
    const ctx = ctxWith(script);
    await tradeRepublicAdapter.sync(ctx, makeConnection('trade_republic'));
    expect(ctx.urls).toEqual([TRADE_REPUBLIC_WS]);
    expect(ctx.headers[0]?.Cookie).toBe('tr_session=demo-cookie');
    expect(script.sent[0]).toMatch(/^connect 31 \{.*"clientId":"app.traderepublic.com"/);
    expect(script.sent.some((s) => s.startsWith('unsub '))).toBe(true);
    expect(script.isClosed()).toBe(true);
  });

  it('builds a EUR brokerage account from positions, live prices and cash', async () => {
    const result = await tradeRepublicAdapter.sync(freshCtx(), makeConnection('trade_republic'));
    await expectSyncShape(result);
    expect(result.holdings.map((h) => [h.symbol, h.quantity, h.price, h.costBasis])).toEqual([
      ['IE00BK5BQT80', '12.5', '108.2', 123_000],
      ['US0000000001', '2', '190.25', 36_000],
    ]);
    // 12.5 x 108.20 + 2 x 190.25 + 250.40 cash = 1352.50 + 380.50 + 250.40
    expect(result.accounts[0]).toMatchObject({
      type: 'brokerage',
      currency: 'EUR',
      balance: 135_250 + 38_050 + 25_040,
    });
  });

  it('reads the timeline through its cursors and signs cash events', async () => {
    const script = fakeSocket(TOPICS);
    const { activities } = await tradeRepublicAdapter.sync(
      ctxWith(script),
      makeConnection('trade_republic'),
    );
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('tr_ev-1')).toMatchObject({
      type: 'buy',
      amount: -10_000,
      symbol: 'IE00BK5BQT80',
      quantity: null,
    });
    expect(byId.get('tr_ev-2')).toMatchObject({ type: 'contribution', amount: 50_000 });
    expect(byId.get('tr_ev-3')).toMatchObject({ type: 'interest', amount: 180 });
    expect(byId.get('tr_ev-4')).toMatchObject({
      type: 'sell',
      amount: 38_050,
      symbol: 'US0000000001',
    });
    expect(byId.get('tr_ev-5')).toMatchObject({ type: 'withdrawal', amount: -20_000 });
    expect(byId.get('tr_ev-6')).toMatchObject({ type: 'dividend', amount: 420 });
    expect(byId.has('tr_ev-x')).toBe(false); // not a money event
    expect(script.sent.filter((s) => s.includes('timelineTransactions')).length).toBe(2);
  });

  it('records each position as one opening lot at the average buy-in price, and is quiet on repeat', async () => {
    const { store } = await expectRepeatSyncIsQuiet(tradeRepublicAdapter, freshCtx);
    const world = store.securities.find((s) => s.symbol === 'IE00BK5BQT80');
    const lots = store.taxLots.filter(
      (l) => l.holdingId === store.holdings.find((h) => h.securityId === world?.id)?.id,
    );
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ quantity: '12.5', costBasis: 123_000, source: 'derived' });
  });

  it('asks for repair when Trade Republic ends the session', async () => {
    const ended = ctxWith(
      fakeSocket(TOPICS, { error: '{"errors":[{"errorCode":"AUTHENTICATION_ERROR"}]}' }),
    );
    await expect(
      tradeRepublicAdapter.sync(ended, makeConnection('trade_republic')),
    ).rejects.toBeInstanceOf(ConnectorRepairNeededError);
    await expect(
      tradeRepublicAdapter.sync(freshCtx(), makeConnection('trade_republic', {})),
    ).resolves.toBeTruthy();
    await expect(
      tradeRepublicAdapter.sync(ctxWith(fakeSocket(TOPICS), {}), makeConnection('trade_republic')),
    ).rejects.toBeInstanceOf(ConnectorRepairNeededError);
  });

  it('stops with a setup error when the Worker cannot open sockets', async () => {
    await expect(
      tradeRepublicAdapter.sync(makeCtx(SECRETS, fakeFetch({})), makeConnection('trade_republic')),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });
});
