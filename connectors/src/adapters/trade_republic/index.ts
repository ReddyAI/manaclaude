import type {
  Connection,
  ConnectorContext,
  InvestmentActivityType,
  ProviderActivity,
  SocketLike,
  SyncResult,
} from '@manaclaude/shared';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { negate, toDecimalString, toMinor } from '../../util/decimal';
import { connectionSecret, defineAdapter, emptyResult, providerAccount } from '../../kit';
import {
  ConnectorConfigError,
  ProviderDataError,
  ProviderHttpError,
  repairNeeded,
} from '../../errors';

/**
 * Trade Republic (EU), EXPERIMENTAL. Trade Republic has no public API; its web
 * app talks over a WebSocket and Sure's client for it
 * (app/models/provider/trade_republic_client.rb, trade_republic_session.rb,
 * trade_republic_timeline_event.rb, trade_republic_websocket.rb) is the
 * reference for the topics and event types read here. Expect it to need
 * maintenance, and read the README before relying on it.
 *
 * - Login (phone, PIN, app or QR confirmation) is a browser-style flow done by
 *   the app's repair screen; what this adapter needs from it is the session
 *   cookie, stored as TRADEREPUBLIC_SESSION. When Trade Republic ends the
 *   session (about every few weeks) the connection needs repair.
 * - The Worker must supply ctx.connectSocket; without it the sync stops with a
 *   setup error. Tests use a scripted fake socket.
 * - Topics: compactPortfolio (positions: ISIN, netSize, averageBuyIn), cash,
 *   ticker (last price per ISIN on LSX), timelineTransactions (cash events).
 * - Activities come from the timeline's cash amounts only (deposits, withdrawals,
 *   interest, dividends, and trades as buy or sell with no quantity). Trade
 *   quantities need per-event detail calls that are not made, so lots are one
 *   opening lot at the average buy-in price.
 */

export const TRADE_REPUBLIC_WS = 'wss://api.traderepublic.com';
const CONNECT_MESSAGE = {
  locale: 'en',
  platformId: 'webtrading',
  platformVersion: 'chrome - 94.0.4606',
  clientId: 'app.traderepublic.com',
  clientVersion: '5582',
};
const REPLY_TIMEOUT_MS = 15_000;
const MAX_TIMELINE_PAGES = 20;

const EVENT_CATEGORY: Record<string, InvestmentActivityType | 'trade' | null> = {
  TRADING_TRADE_EXECUTED: 'trade',
  TRADE_INVOICE: 'trade',
  ORDER_EXECUTED: 'trade',
  SAVINGS_PLAN_EXECUTED: 'trade',
  TRADING_SAVINGSPLAN_EXECUTED: 'trade',
  SAVINGS_PLAN_INVOICE_CREATED: 'trade',
  PAYMENT_INBOUND: 'contribution',
  PAYMENT_INBOUND_SEPA_DIRECT_DEBIT: 'contribution',
  INCOMING_TRANSFER: 'contribution',
  BANK_TRANSACTION_INCOMING: 'contribution',
  PAYMENT_OUTBOUND: 'withdrawal',
  OUTGOING_TRANSFER: 'withdrawal',
  BANK_TRANSACTION_OUTGOING: 'withdrawal',
  CARD_TRANSACTION: 'withdrawal',
  INTEREST_PAYOUT: 'interest',
  INTEREST_PAYOUT_CREATED: 'interest',
  DIVIDEND: 'dividend',
  CREDIT: 'dividend',
  SSP_CORPORATE_ACTION_CASH: 'dividend',
  STAMP_DUTY_TAX_PAID: 'fee',
  CARD_ORDER_FEE: 'fee',
};

interface Position {
  instrumentId: string;
  netSize: string;
  averageBuyIn: string;
  name?: string;
  shortName?: string;
}
interface TimelineItem {
  id: string;
  timestamp: number | string;
  title?: string;
  body?: string;
  cashChangeAmount?: number | string;
  eventType?: string;
  action?: { payload?: string } | null;
}

/** Request/response over the subscription protocol: "sub <id> <json>" answers "<id> A <json>". */
class TradeRepublicSession {
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private connected: { resolve: () => void; reject: (e: Error) => void } | null = null;

  private constructor(private readonly socket: SocketLike) {
    socket.onMessage((text) => this.handle(text));
    socket.onClose(() => {
      const closed = new ProviderHttpError('Trade Republic', 0, 'socket closed');
      this.connected?.reject(closed);
      for (const w of this.waiting.values()) w.reject(closed);
      this.waiting.clear();
    });
  }

  static async open(ctx: ConnectorContext, cookie: string): Promise<TradeRepublicSession> {
    if (!ctx.connectSocket)
      throw new ConnectorConfigError(
        'Trade Republic needs WebSocket support from the Worker (ctx.connectSocket)',
      );
    const socket = await ctx.connectSocket(TRADE_REPUBLIC_WS, {
      Cookie: cookie,
      Origin: 'https://app.traderepublic.com',
    });
    const session = new TradeRepublicSession(socket);
    await within(
      REPLY_TIMEOUT_MS,
      'connect',
      new Promise<void>((resolve, reject) => {
        session.connected = { resolve, reject };
        socket.send(`connect 31 ${JSON.stringify(CONNECT_MESSAGE)}`);
      }),
    );
    return session;
  }

  private handle(text: string): void {
    if (text.trim() === 'connected') {
      this.connected?.resolve();
      this.connected = null;
      return;
    }
    const m = /^(\d+)\s+([ADCE])\s*([\s\S]*)$/.exec(text);
    if (!m) return;
    const id = Number(m[1]);
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    if (m[2] === 'E') {
      this.waiting.delete(id);
      waiter.reject(
        /AUTHENTICATION|UNAUTHORI[SZ]ED|SESSION/i.test(m[3] ?? '')
          ? repairNeeded('Trade Republic', 'the session ended')
          : new ProviderHttpError('Trade Republic', 400, m[3] ?? ''),
      );
    } else if (m[2] === 'A') {
      this.waiting.delete(id);
      try {
        waiter.resolve(JSON.parse(m[3] || 'null'));
      } catch {
        waiter.reject(new ProviderDataError('Trade Republic', 'reply'));
      }
    }
  }

  async request<T>(payload: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(`sub ${id} ${JSON.stringify(payload)}`);
    });
    try {
      return (await within(REPLY_TIMEOUT_MS, String(payload.type), answer)) as T;
    } finally {
      this.waiting.delete(id);
      this.socket.send(`unsub ${id}`);
    }
  }

  close(): void {
    this.socket.close();
  }
}

/** Wait for `work`, but give up (and clear the timer either way) after `ms`. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderHttpError('Trade Republic', 408, `timeout on ${what}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function syncTradeRepublic(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const cookie = connectionSecret(ctx, 'TRADEREPUBLIC_SESSION', 'Trade Republic');
  const today = todayUtc(ctx.now());
  const result = emptyResult();
  const session = await TradeRepublicSession.open(ctx, cookie);
  try {
    const accountId = 'traderepublic_main';
    const portfolio = await session.request<{ positions?: Position[] }>({
      type: 'compactPortfolio',
    });
    const cashRows = await session.request<{ currencyId?: string; amount?: number | string }[]>({
      type: 'cash',
    });
    const currency = (cashRows?.[0]?.currencyId ?? 'EUR').toUpperCase();
    const cash = toMinor(cashRows?.[0]?.amount ?? 0, currency);

    let value = 0;
    for (const p of portfolio?.positions ?? []) {
      const quantity = toDecimalString(p.netSize);
      if (!quantity || quantity === '0') continue;
      const tick = await session
        .request<{ last?: { price?: string | number }; bid?: { price?: string | number } }>({
          type: 'ticker',
          id: `${p.instrumentId}.LSX`,
        })
        .catch(() => null);
      const price =
        toDecimalString(tick?.last?.price ?? tick?.bid?.price) ??
        toDecimalString(p.averageBuyIn) ??
        '0';
      result.holdings.push({
        accountExternalId: accountId,
        symbol: p.instrumentId,
        name: p.name ?? p.shortName ?? p.instrumentId,
        securityType: 'equity',
        exchange: null,
        quantity,
        price,
        currency,
        costBasis: toMinor(Number(quantity) * Number(p.averageBuyIn), currency),
        lots: null,
      });
      value += toMinor(Number(quantity) * Number(price), currency);
    }
    result.accounts.push(
      providerAccount({
        externalId: accountId,
        name: 'Trade Republic',
        institutionName: 'Trade Republic',
        type: 'brokerage',
        subtype: 'taxable',
        currency,
        balance: value + cash,
      }),
    );

    let after: string | undefined;
    for (let page = 0; page < MAX_TIMELINE_PAGES; page++) {
      const t = await session.request<{
        items?: TimelineItem[];
        cursors?: { after?: string | null };
      }>({ type: 'timelineTransactions', ...(after ? { after } : {}) });
      for (const item of t?.items ?? []) {
        const category = item.eventType ? EVENT_CATEGORY[item.eventType] : null;
        const date = toLocalDate(
          typeof item.timestamp === 'string' && /^\d+$/.test(item.timestamp)
            ? Number(item.timestamp)
            : item.timestamp,
        );
        const cashChange = toMinor(item.cashChangeAmount ?? 0, currency);
        if (!category || !date || !item.id) continue;
        const type: InvestmentActivityType =
          category === 'trade' ? (cashChange <= 0 ? 'buy' : 'sell') : category;
        const act: ProviderActivity = {
          externalId: `tr_${item.id}`,
          accountExternalId: accountId,
          symbol: category === 'trade' ? (item.action?.payload ?? null) : null,
          type,
          date,
          quantity: null,
          price: null,
          // The timeline's cashChangeAmount is signed from the account's side.
          amount:
            category === 'withdrawal' || category === 'fee'
              ? negate(Math.abs(cashChange))
              : cashChange,
          fees: 0,
          currency,
          splitRatio: null,
        };
        result.activities.push(act);
      }
      after = t?.cursors?.after ?? undefined;
      if (!after) break;
    }
  } finally {
    session.close();
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const tradeRepublicAdapter = defineAdapter({
  id: 'trade_republic',
  sync: syncTradeRepublic,
});
