import type { Id, IsoDateTime, LocalDate, MinorUnits } from '../model/common';
import type { Receipt } from '../model/receipt';
import type { Rule } from '../model/rule';
import type { Merchant, Transaction, TransferLink, TransferLinkKind } from '../model/transaction';
import { addDays, daysBetween, monthOf, dayOfWeek } from '../dates/dates';
import { impliedRateOf } from '../fx/convert';
import { createRandom, type Random } from './random';

/**
 * Four months of sample activity built to exercise the money policies:
 * linked transfers and card payments, a USD to NRE transfer with its real rate,
 * ATM cash, a split loan payment, refunds across months, two identical coffees
 * on one day, a foreign purchase, receipts, pending rows and AI confidence.
 */

export interface SampleTransactionData {
  transactions: Transaction[];
  transferLinks: TransferLink[];
  merchants: Merchant[];
  receipts: Receipt[];
  rules: Rule[];
}

const MERCHANTS: Merchant[] = [
  {
    id: 'mer_wholefoods',
    name: 'Whole Foods',
    defaultCategoryId: 'cat_groceries',
    aliases: ['WHOLEFDS MKT'],
  },
  {
    id: 'mer_traderjoes',
    name: "Trader Joe's",
    defaultCategoryId: 'cat_groceries',
    aliases: ['TRADER JOE S'],
  },
  {
    id: 'mer_costco',
    name: 'Costco',
    defaultCategoryId: 'cat_groceries',
    aliases: ['COSTCO WHSE'],
  },
  {
    id: 'mer_safeway',
    name: 'Safeway',
    defaultCategoryId: 'cat_groceries',
    aliases: ['SAFEWAY STORE'],
  },
  {
    id: 'mer_starbucks',
    name: 'Starbucks',
    defaultCategoryId: 'cat_coffee',
    aliases: ['STARBUCKS STORE'],
  },
  {
    id: 'mer_bluebottle',
    name: 'Blue Bottle Coffee',
    defaultCategoryId: 'cat_coffee',
    aliases: ['BLUE BOTTLE COFFE'],
  },
  {
    id: 'mer_chipotle',
    name: 'Chipotle',
    defaultCategoryId: 'cat_dining',
    aliases: ['CHIPOTLE ONLINE'],
  },
  {
    id: 'mer_sweetgreen',
    name: 'Sweetgreen',
    defaultCategoryId: 'cat_dining',
    aliases: ['SWEETGREEN'],
  },
  {
    id: 'mer_tandoori',
    name: 'Tandoori Nights',
    defaultCategoryId: 'cat_dining',
    aliases: ['TST* TANDOORI NIGHTS'],
  },
  {
    id: 'mer_pho',
    name: 'Pho Corner',
    defaultCategoryId: 'cat_dining',
    aliases: ['SQ *PHO CORNER'],
  },
  { id: 'mer_uber', name: 'Uber', defaultCategoryId: 'cat_rideshare', aliases: ['UBER *TRIP'] },
  { id: 'mer_lyft', name: 'Lyft', defaultCategoryId: 'cat_rideshare', aliases: ['LYFT *RIDE'] },
  { id: 'mer_shell', name: 'Shell', defaultCategoryId: 'cat_gas', aliases: ['SHELL OIL'] },
  { id: 'mer_chevron', name: 'Chevron', defaultCategoryId: 'cat_gas', aliases: ['CHEVRON'] },
  {
    id: 'mer_amazon',
    name: 'Amazon',
    defaultCategoryId: 'cat_shopping',
    aliases: ['AMZN MKTP US'],
  },
  { id: 'mer_target', name: 'Target', defaultCategoryId: 'cat_shopping', aliases: ['TARGET'] },
  {
    id: 'mer_netflix',
    name: 'Netflix',
    defaultCategoryId: 'cat_subscriptions',
    aliases: ['NETFLIX.COM'],
  },
  {
    id: 'mer_spotify',
    name: 'Spotify',
    defaultCategoryId: 'cat_subscriptions',
    aliases: ['SPOTIFY USA'],
  },
  {
    id: 'mer_icloud',
    name: 'iCloud+',
    defaultCategoryId: 'cat_subscriptions',
    aliases: ['APPLE.COM/BILL'],
  },
  {
    id: 'mer_gym',
    name: 'Iron Works Gym',
    defaultCategoryId: 'cat_fitness',
    aliases: ['IRON WORKS GYM'],
  },
  {
    id: 'mer_verizon',
    name: 'Verizon',
    defaultCategoryId: 'cat_internet',
    aliases: ['VZWRLSS*APOCC'],
  },
  {
    id: 'mer_xfinity',
    name: 'Xfinity',
    defaultCategoryId: 'cat_internet',
    aliases: ['COMCAST XFINITY'],
  },
  {
    id: 'mer_power',
    name: 'City Power & Light',
    defaultCategoryId: 'cat_utilities',
    aliases: ['CITY POWER LIGHT'],
  },
  {
    id: 'mer_insurance',
    name: 'Safe Road Insurance',
    defaultCategoryId: 'cat_car',
    aliases: ['SAFE ROAD INS'],
  },
  {
    id: 'mer_cvs',
    name: 'CVS Pharmacy',
    defaultCategoryId: 'cat_health',
    aliases: ['CVS/PHARMACY'],
  },
  {
    id: 'mer_cinema',
    name: 'Downtown Cinema',
    defaultCategoryId: 'cat_entertainment',
    aliases: ['DOWNTOWN CINEMA'],
  },
  {
    id: 'mer_landlord',
    name: 'Parkside Apartments',
    defaultCategoryId: 'cat_rent',
    aliases: ['PARKSIDE APTS'],
  },
  {
    id: 'mer_employer',
    name: 'Acme Corp payroll',
    defaultCategoryId: 'cat_paycheck',
    aliases: ['ACME CORP PAYROLL'],
  },
];

interface Ctx {
  rnd: Random;
  now: IsoDateTime;
  today: LocalDate;
  txns: Transaction[];
  links: TransferLink[];
  seq: number;
}

type TxnInput = Pick<Transaction, 'accountId' | 'date' | 'amount' | 'name' | 'rawName'> &
  Partial<Transaction>;

const ACCOUNT_CURRENCY: Record<Id, string> = {
  acc_checking: 'USD',
  acc_savings: 'USD',
  acc_card_cashback: 'USD',
  acc_card_travel: 'USD',
  acc_cash_usd: 'USD',
  acc_cash_inr: 'INR',
  acc_nre: 'INR',
  acc_nro: 'INR',
  acc_brokerage: 'USD',
  acc_401k: 'USD',
  acc_demat: 'INR',
  acc_crypto: 'USD',
  acc_car: 'USD',
  acc_auto_loan: 'USD',
};

const CONNECTION_OF: Record<Id, Id | null> = {
  acc_checking: 'conn_simplefin_lakeshore',
  acc_card_cashback: 'conn_simplefin_lakeshore',
  acc_savings: 'conn_plaid_harbor',
  acc_card_travel: 'conn_sophtron_summit',
  acc_brokerage: 'conn_snaptrade_northfield',
};

function add(ctx: Ctx, input: TxnInput): Transaction {
  ctx.seq += 1;
  const currency = input.currency ?? ACCOUNT_CURRENCY[input.accountId] ?? 'USD';
  const connectionId =
    input.connectionId !== undefined
      ? input.connectionId
      : (CONNECTION_OF[input.accountId] ?? null);
  const age = daysBetween(input.date, ctx.today);
  const txn: Transaction = {
    id: input.id ?? `txn_${String(ctx.seq).padStart(4, '0')}`,
    currency,
    originalAmount: input.amount,
    originalCurrency: currency,
    merchantId: null,
    categoryId: null,
    categorySource: input.categoryId ? 'ai' : null,
    aiCategoryConfidence: null,
    kind: 'regular',
    pending: false,
    notes: null,
    tagIds: [],
    excluded: false,
    transferLinkId: null,
    receiptId: null,
    recurringId: null,
    splitParentId: null,
    isSplitParent: false,
    reviewed: age > 9,
    reviewedAt: age > 9 ? `${addDays(input.date, 1)}T16:00:00.000Z` : null,
    userEditedFields: [],
    source: connectionId ? 'connector' : 'manual',
    connectionId,
    externalId: connectionId ? `ext_${ctx.seq}` : null,
    pendingExternalId: null,
    importId: null,
    importFingerprint: null,
    createdAt: `${input.date}T12:00:00.000Z`,
    updatedAt: ctx.now,
    ...input,
  };
  if (txn.categorySource === 'ai' && txn.aiCategoryConfidence === null) {
    txn.aiCategoryConfidence = Math.round((0.72 + ctx.rnd.next() * 0.27) * 100) / 100;
  }
  ctx.txns.push(txn);
  return txn;
}

function link(
  ctx: Ctx,
  out: Transaction,
  into: Transaction,
  kind: TransferLinkKind,
  status: TransferLink['status'] = 'auto',
): TransferLink {
  const id = `tl_${String(ctx.links.length + 1).padStart(3, '0')}`;
  const l: TransferLink = {
    id,
    outTransactionId: out.id,
    inTransactionId: into.id,
    outAmount: Math.abs(out.amount),
    outCurrency: out.currency,
    inAmount: Math.abs(into.amount),
    inCurrency: into.currency,
    impliedRate:
      Math.round(impliedRateOf(out.amount, out.currency, into.amount, into.currency) * 10_000) /
      10_000,
    status,
    kind,
    matchScore: status === 'confirmed' ? null : 0.97,
    matchedBy: status === 'confirmed' ? 'user' : 'matcher',
    createdAt: `${into.date}T13:00:00.000Z`,
    updatedAt: ctx.now,
  };
  out.transferLinkId = id;
  into.transferLinkId = id;
  ctx.links.push(l);
  return l;
}

function cents(rnd: Random, min: number, max: number): MinorUnits {
  return rnd.int(Math.round(min * 100), Math.round(max * 100));
}

function merchant(id: Id): Merchant {
  const m = MERCHANTS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown merchant ${id}`);
  return m;
}

function purchase(
  ctx: Ctx,
  date: LocalDate,
  accountId: Id,
  merchantId: Id,
  amount: MinorUnits,
  extra: Partial<Transaction> = {},
): Transaction {
  const m = merchant(merchantId);
  return add(ctx, {
    accountId,
    date,
    amount: -Math.abs(amount),
    name: m.name,
    rawName: `${m.aliases[0] ?? m.name.toUpperCase()} ${1000 + ((ctx.seq * 37) % 9000)}`,
    merchantId,
    categoryId: m.defaultCategoryId,
    ...extra,
  });
}

/** USD to INR around 88 for sample transfers (the FX table is separate). */
function sampleUsdInr(rnd: Random): number {
  return 87.6 + rnd.next() * 1.2;
}

export function sampleTransactionData(
  today: LocalDate,
  now: IsoDateTime,
  seed = 7,
): SampleTransactionData {
  const ctx: Ctx = { rnd: createRandom(seed), now, today, txns: [], links: [], seq: 0 };
  const { rnd } = ctx;
  const start = addDays(today, -119);
  const cardSpendByMonth: Record<string, number> = {};
  const travelSpendByMonth: Record<string, number> = {};
  const card = (
    date: LocalDate,
    merchantId: Id,
    amount: MinorUnits,
    extra: Partial<Transaction> = {},
  ) => {
    const t = purchase(ctx, date, 'acc_card_cashback', merchantId, amount, extra);
    cardSpendByMonth[monthOf(date)] = (cardSpendByMonth[monthOf(date)] ?? 0) + amount;
    return t;
  };
  const travelCard = (
    date: LocalDate,
    merchantId: Id,
    amount: MinorUnits,
    extra: Partial<Transaction> = {},
  ) => {
    const t = purchase(ctx, date, 'acc_card_travel', merchantId, amount, extra);
    travelSpendByMonth[monthOf(date)] = (travelSpendByMonth[monthOf(date)] ?? 0) + amount;
    return t;
  };

  const indiaTripStart = addDays(today, -52);
  const indiaTripEnd = addDays(today, -42);

  for (let i = 0; i <= 119; i += 1) {
    const date = addDays(start, i);
    const dom = Number(date.slice(8, 10));
    const dow = dayOfWeek(date);
    const inIndia = date >= indiaTripStart && date <= indiaTripEnd;

    // Income: payroll every other Friday.
    if (dow === 5 && Math.floor(daysBetween('2026-01-02', date) / 7) % 2 === 0) {
      add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: 421_538,
        name: 'Acme Corp payroll',
        rawName: 'ACME CORP PAYROLL PPD',
        merchantId: 'mer_employer',
        categoryId: 'cat_paycheck',
        categorySource: 'rule',
        recurringId: 'rec_paycheck',
      });
    }

    // Monthly bills.
    if (dom === 1) {
      add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -235_000,
        name: 'Parkside Apartments',
        rawName: 'ZELLE PAYMENT TO PARKSIDE APTS',
        merchantId: 'mer_landlord',
        categoryId: 'cat_rent',
        categorySource: 'rule',
        recurringId: 'rec_rent',
      });
      card(date, 'mer_gym', 4_900, { recurringId: 'rec_gym' });
    }
    if (dom === 5) card(date, 'mer_spotify', 1_199, { recurringId: 'rec_spotify' });
    if (dom === 9) {
      purchase(ctx, date, 'acc_checking', 'mer_xfinity', 7_999, { recurringId: 'rec_internet' });
    }
    if (dom === 12) {
      // Price went up two months ago: a price-increase alert case.
      const raised = daysBetween(date, today) < 62;
      card(date, 'mer_netflix', raised ? 1_799 : 1_549, { recurringId: 'rec_netflix' });
    }
    if (dom === 18)
      purchase(ctx, date, 'acc_checking', 'mer_verizon', 8_500, { recurringId: 'rec_phone' });
    if (dom === 20) card(date, 'mer_icloud', 299, { recurringId: 'rec_icloud' });
    if (dom === 22)
      purchase(ctx, date, 'acc_checking', 'mer_power', cents(rnd, 88, 142), {
        recurringId: 'rec_power',
      });

    // Savings transfer on the 3rd (arrives next day).
    if (dom === 3) {
      const out = add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -100_000,
        name: 'Transfer to High-Yield Savings',
        rawName: 'ONLINE TRANSFER TO SAV ...7730',
        kind: 'transfer',
        categoryId: 'cat_transfer',
        categorySource: 'rule',
      });
      const into = add(ctx, {
        accountId: 'acc_savings',
        date: addDays(date, 1),
        amount: 100_000,
        name: 'Transfer from Everyday Checking',
        rawName: 'ONLINE TRANSFER FROM CHK ...4821',
        kind: 'transfer',
        categoryId: 'cat_transfer',
        categorySource: 'rule',
      });
      link(ctx, out, into, 'transfer');
    }

    // Brokerage contribution on the 6th.
    if (dom === 6) {
      const out = add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -50_000,
        name: 'Transfer to Individual Brokerage',
        rawName: 'ACH TRANSFER NORTHFIELD INV',
        kind: 'investment_contribution',
        categoryId: 'cat_investment_contribution',
        categorySource: 'rule',
      });
      const into = add(ctx, {
        accountId: 'acc_brokerage',
        date: addDays(date, 1),
        amount: 50_000,
        name: 'Deposit from Everyday Checking',
        rawName: 'ACH DEPOSIT',
        kind: 'investment_contribution',
        categoryId: 'cat_investment_contribution',
        categorySource: 'rule',
      });
      link(ctx, out, into, 'investment_contribution');
    }

    // Auto loan on the 10th: one payment split into principal (a transfer to the loan) and interest (spending).
    if (dom === 10) {
      const parent = add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -45_218,
        name: 'Auto loan payment',
        rawName: 'LAKESHORE BANK AUTO LOAN PMT',
        categoryId: 'cat_loan_payment',
        categorySource: 'rule',
        isSplitParent: true,
        recurringId: 'rec_auto_loan',
      });
      const interest = 6_278 - Math.floor(daysBetween(start, date) / 30) * 41;
      const principal = add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -(45_218 - interest),
        name: 'Auto loan principal',
        rawName: parent.rawName,
        kind: 'loan_payment',
        categoryId: 'cat_loan_payment',
        categorySource: 'user',
        splitParentId: parent.id,
        externalId: null,
      });
      add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -interest,
        name: 'Auto loan interest',
        rawName: parent.rawName,
        categoryId: 'cat_loan_interest',
        categorySource: 'user',
        splitParentId: parent.id,
        externalId: null,
      });
      const loanSide = add(ctx, {
        accountId: 'acc_auto_loan',
        date,
        amount: 45_218 - interest,
        name: 'Payment received',
        rawName: 'PAYMENT RECEIVED',
        kind: 'loan_payment',
        categoryId: 'cat_loan_payment',
        categorySource: 'rule',
      });
      link(ctx, principal, loanSide, 'loan_payment');
    }

    // USD to NRE on the 15th; arrives two days later in INR with the real rate.
    if (dom === 15) {
      const usd = 200_000;
      const rate = sampleUsdInr(rnd);
      const inr = Math.round((usd / 100 - 4.5) * rate * 100);
      const out = add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -usd,
        name: 'Wise transfer to NRE Savings',
        rawName: 'WISE US INC TRANSFER',
        kind: 'transfer',
        categoryId: 'cat_transfer',
        categorySource: 'rule',
      });
      const arrive = addDays(date, 2);
      if (arrive <= today) {
        const into = add(ctx, {
          accountId: 'acc_nre',
          date: arrive,
          amount: inr,
          name: 'Inward remittance from Wise',
          rawName: 'INW REM WISE PAYMENTS LTD',
          kind: 'transfer',
          categoryId: 'cat_transfer',
          categorySource: 'import',
          source: 'import',
          connectionId: null,
        });
        link(ctx, out, into, 'transfer');
      }
    }

    // Card payments: pay last month's statement in full.
    if (dom === 25) {
      const prev = monthOf(addDays(`${date.slice(0, 7)}-01`, -1));
      const due = cardSpendByMonth[prev] ?? cents(rnd, 1800, 2400);
      const out = add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -due,
        name: 'Payment to Cashback Visa',
        rawName: 'LAKESHORE CARD PAYMENT',
        kind: 'card_payment',
        categoryId: 'cat_card_payment',
        categorySource: 'rule',
      });
      const into = add(ctx, {
        accountId: 'acc_card_cashback',
        date,
        amount: due,
        name: 'Payment received, thank you',
        rawName: 'PAYMENT - THANK YOU',
        kind: 'card_payment',
        categoryId: 'cat_card_payment',
        categorySource: 'rule',
      });
      link(ctx, out, into, 'card_payment');
    }
    if (dom === 27) {
      const prev = monthOf(addDays(`${date.slice(0, 7)}-01`, -1));
      const due = travelSpendByMonth[prev] ?? cents(rnd, 300, 700);
      const out = add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -due,
        name: 'Payment to Travel Rewards Card',
        rawName: 'SUMMIT CARD PAYMENT',
        kind: 'card_payment',
        categoryId: 'cat_card_payment',
        categorySource: 'rule',
      });
      const into = add(ctx, {
        accountId: 'acc_card_travel',
        date: addDays(date, 1) <= today ? addDays(date, 1) : date,
        amount: due,
        name: 'Payment received',
        rawName: 'AUTOPAY PAYMENT RECEIVED',
        kind: 'card_payment',
        categoryId: 'cat_card_payment',
        categorySource: 'rule',
      });
      link(ctx, out, into, 'card_payment');
    }

    // NRE and NRO monthly items.
    if (dom === 28) {
      add(ctx, {
        accountId: 'acc_nre',
        date,
        amount: rnd.int(98_000, 112_000),
        name: 'Interest credit',
        rawName: 'INT.CR SB ACCOUNT',
        categoryId: 'cat_interest',
        categorySource: 'ai',
        source: 'import',
        connectionId: null,
      });
    }
    if (dom === 5) {
      add(ctx, {
        accountId: 'acc_nro',
        date,
        amount: 1_800_000,
        name: 'Rent received',
        rawName: 'NEFT CR TENANT RENT',
        categoryId: 'cat_rental_income',
        categorySource: 'ai',
        source: 'import',
        connectionId: null,
      });
    }

    // Everyday spending.
    if (!inIndia) {
      if (i % 4 === 1)
        card(
          date,
          rnd.pick(['mer_wholefoods', 'mer_traderjoes', 'mer_safeway']),
          cents(rnd, 38, 135),
        );
      if (rnd.chance(0.42))
        card(date, rnd.pick(['mer_chipotle', 'mer_sweetgreen', 'mer_pho']), cents(rnd, 12, 48));
      if (rnd.chance(0.55))
        card(date, rnd.pick(['mer_starbucks', 'mer_bluebottle']), cents(rnd, 4.5, 7.25));
      if (rnd.chance(0.25)) card(date, rnd.pick(['mer_uber', 'mer_lyft']), cents(rnd, 9, 34));
      if (i % 9 === 4) travelCard(date, rnd.pick(['mer_shell', 'mer_chevron']), cents(rnd, 38, 62));
      if (rnd.chance(0.16)) card(date, rnd.pick(['mer_amazon', 'mer_target']), cents(rnd, 12, 140));
      if (rnd.chance(0.05)) card(date, 'mer_cvs', cents(rnd, 8, 46));
      if (rnd.chance(0.04)) card(date, 'mer_cinema', cents(rnd, 18, 42));
    }

    // ATM cash every three weeks, then small cash purchases.
    if (i % 21 === 2 && !inIndia) {
      const out = add(ctx, {
        accountId: 'acc_checking',
        date,
        amount: -20_000,
        name: 'ATM withdrawal',
        rawName: 'ATM WITHDRAWAL 0042',
        kind: 'transfer',
        categoryId: 'cat_transfer',
        categorySource: 'rule',
      });
      const into = add(ctx, {
        accountId: 'acc_cash_usd',
        date,
        amount: 20_000,
        name: 'Cash from ATM',
        rawName: 'Cash from ATM',
        kind: 'transfer',
        categoryId: 'cat_transfer',
        categorySource: 'user',
        source: 'manual',
      });
      link(ctx, out, into, 'atm_withdrawal');
    }
    if (i % 7 === 6 && !inIndia) {
      add(ctx, {
        accountId: 'acc_cash_usd',
        date,
        amount: -cents(rnd, 12, 32),
        name: 'Farmers market',
        rawName: 'Farmers market',
        categoryId: 'cat_groceries',
        categorySource: 'user',
        source: 'manual',
        reviewed: true,
      });
    }
  }

  // India trip: cash in INR, card purchases charged in INR on a USD card.
  {
    const atmDay = addDays(indiaTripStart, 1);
    const out = add(ctx, {
      accountId: 'acc_nro',
      date: atmDay,
      amount: -1_000_000,
      name: 'ATM withdrawal',
      rawName: 'ATM WDL HYDERABAD',
      kind: 'transfer',
      categoryId: 'cat_transfer',
      categorySource: 'rule',
      source: 'import',
      connectionId: null,
    });
    const into = add(ctx, {
      accountId: 'acc_cash_inr',
      date: atmDay,
      amount: 1_000_000,
      name: 'Cash from ATM',
      rawName: 'Cash from ATM',
      kind: 'transfer',
      categoryId: 'cat_transfer',
      categorySource: 'user',
      source: 'manual',
    });
    link(ctx, out, into, 'atm_withdrawal');
    const cashItems: [string, Id, number][] = [
      ['Auto rickshaw', 'cat_rideshare', 18_000],
      ['Chai and snacks', 'cat_dining', 9_000],
      ['Kirana store', 'cat_groceries', 124_000],
      ['Temple donation', 'cat_gifts', 50_100],
      ['Auto rickshaw', 'cat_rideshare', 22_000],
      ['Sweets for family', 'cat_gifts', 86_000],
      ['Street food', 'cat_dining', 14_500],
      ['Pharmacy', 'cat_health', 32_000],
      ['Gifts for nieces', 'cat_gifts', 300_000],
    ];
    cashItems.forEach(([name, categoryId, amount], k) => {
      add(ctx, {
        accountId: 'acc_cash_inr',
        date: addDays(indiaTripStart, 1 + k),
        amount: -amount,
        name,
        rawName: name,
        categoryId,
        categorySource: 'user',
        source: 'manual',
        tagIds: ['tag_india_trip'],
      });
    });
    const inrCard = (offset: number, name: string, inr: number, categoryId: Id) => {
      const usd = Math.round((inr / 88.1) * 1.0);
      travelCard(addDays(indiaTripStart, offset), 'mer_shell', usd, {
        name,
        rawName: `${name.toUpperCase()} HYDERABAD IN`,
        merchantId: null,
        categoryId,
        originalAmount: -inr,
        originalCurrency: 'INR',
        tagIds: ['tag_india_trip'],
      });
    };
    inrCard(0, 'Hotel stay, Hyderabad', 1_250_000, 'cat_travel');
    inrCard(3, 'Swiggy', 64_800, 'cat_dining');
    inrCard(6, 'Big Bazaar', 412_000, 'cat_shopping');
    travelCard(addDays(indiaTripStart, -1), 'mer_shell', 128_450, {
      name: 'Air India',
      rawName: 'AIR INDIA ETKT',
      merchantId: null,
      categoryId: 'cat_travel',
      tagIds: ['tag_india_trip'],
    });
  }

  // Foreign purchase in EUR on the travel card.
  travelCard(addDays(today, -70), 'mer_shell', 4_931, {
    name: 'Le Petit Cafe, Paris',
    rawName: 'LE PETIT CAFE PARIS FR',
    merchantId: null,
    categoryId: 'cat_dining',
    originalAmount: -4_250,
    originalCurrency: 'EUR',
  });

  // Refunds: one in the same month as the purchase, one crossing into this month.
  const refundBase = addDays(today, -40);
  card(refundBase, 'mer_amazon', 8_999, { name: 'Amazon', notes: 'Headphones, returned' });
  add(ctx, {
    accountId: 'acc_card_cashback',
    date: addDays(refundBase, 6),
    amount: 8_999,
    name: 'Amazon refund',
    rawName: 'AMZN MKTP US REFUND',
    merchantId: 'mer_amazon',
    categoryId: 'cat_shopping',
    categorySource: 'ai',
    connectionId: 'conn_simplefin_lakeshore',
  });
  const thisMonthStart = `${today.slice(0, 7)}-01`;
  card(addDays(thisMonthStart, -6), 'mer_target', 6_450, { name: 'Target' });
  add(ctx, {
    accountId: 'acc_card_cashback',
    date: thisMonthStart,
    amount: 2_450,
    name: 'Target refund',
    rawName: 'TARGET RETURN',
    merchantId: 'mer_target',
    categoryId: 'cat_shopping',
    categorySource: 'ai',
  });

  // Two identical coffees on the same day: both are real purchases (check 2).
  const coffeeDay = addDays(today, -3);
  card(coffeeDay, 'mer_starbucks', 575, { rawName: 'STARBUCKS STORE 04412', id: 'txn_coffee_a' });
  card(coffeeDay, 'mer_starbucks', 575, { rawName: 'STARBUCKS STORE 04412', id: 'txn_coffee_b' });

  // Restaurant with a receipt: card charge includes the tip.
  const dinner = card(addDays(today, -5), 'mer_tandoori', 6_840, {
    id: 'txn_tandoori',
    receiptId: 'rcp_tandoori',
  });

  // Costco run split into groceries and household, with a receipt.
  const costcoDate = addDays(today, -8);
  const costco = card(costcoDate, 'mer_costco', 21_436, {
    id: 'txn_costco',
    isSplitParent: true,
    receiptId: 'rcp_costco',
  });
  add(ctx, {
    accountId: 'acc_card_cashback',
    date: costcoDate,
    amount: -15_012,
    name: 'Costco',
    rawName: costco.rawName,
    merchantId: 'mer_costco',
    categoryId: 'cat_groceries',
    categorySource: 'user',
    splitParentId: costco.id,
    externalId: null,
  });
  add(ctx, {
    accountId: 'acc_card_cashback',
    date: costcoDate,
    amount: -6_424,
    name: 'Costco',
    rawName: costco.rawName,
    merchantId: 'mer_costco',
    categoryId: 'cat_household',
    categorySource: 'user',
    splitParentId: costco.id,
    externalId: null,
  });

  // Car insurance (semiannual).
  card(addDays(today, -33), 'mer_insurance', 64_200, { recurringId: 'rec_car_insurance' });

  // Pending and low-confidence rows for the review queue.
  card(addDays(today, -1), 'mer_uber', 2_318, { pending: true, aiCategoryConfidence: 0.93 });
  card(today, 'mer_sweetgreen', 1_645, { pending: true, aiCategoryConfidence: 0.88 });
  card(addDays(today, -2), 'mer_amazon', 4_799, {
    name: 'Amazon',
    aiCategoryConfidence: 0.41,
    notes: null,
  });
  card(addDays(today, -4), 'mer_target', 3_212, { aiCategoryConfidence: 0.38 });
  add(ctx, {
    accountId: 'acc_card_cashback',
    date: addDays(today, -6),
    amount: -2_650,
    name: 'SQ *GREENLEAF',
    rawName: 'SQ *GREENLEAF 8823',
    categoryId: null,
    categorySource: null,
  });
  add(ctx, {
    accountId: 'acc_checking',
    date: addDays(today, -7),
    amount: -12_000,
    name: 'Venmo',
    rawName: 'VENMO PAYMENT 1029384',
    categoryId: 'cat_gifts',
    categorySource: 'ai',
    aiCategoryConfidence: 0.34,
  });

  const transactions = ctx.txns.sort((a, b) =>
    a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date),
  );

  const receipts: Receipt[] = [
    {
      id: 'rcp_tandoori',
      r2Key: 'receipts/sample/rcp_tandoori.jpg',
      merchant: 'Tandoori Nights',
      date: dinner.date,
      subtotal: 5_290,
      tax: 550,
      tip: 1_000,
      total: 5_840,
      currency: 'USD',
      lineItems: [
        {
          id: 'li_1',
          description: 'Chicken tikka masala',
          quantity: '1',
          amount: 1_895,
          categoryId: 'cat_dining',
        },
        {
          id: 'li_2',
          description: 'Garlic naan',
          quantity: '2',
          amount: 900,
          categoryId: 'cat_dining',
        },
        {
          id: 'li_3',
          description: 'Vegetable biryani',
          quantity: '1',
          amount: 1_695,
          categoryId: 'cat_dining',
        },
        {
          id: 'li_4',
          description: 'Mango lassi',
          quantity: '2',
          amount: 800,
          categoryId: 'cat_dining',
        },
      ],
      matchedTransactionId: dinner.id,
      status: 'matched',
      aiConfidence: 0.94,
      createdAt: `${dinner.date}T21:10:00.000Z`,
      updatedAt: now,
    },
    {
      id: 'rcp_costco',
      r2Key: 'receipts/sample/rcp_costco.jpg',
      merchant: 'Costco',
      date: costcoDate,
      subtotal: 21_436,
      tax: 0,
      tip: null,
      total: 21_436,
      currency: 'USD',
      lineItems: [
        {
          id: 'li_c1',
          description: 'Organic eggs, 24 ct',
          quantity: '1',
          amount: 999,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c2',
          description: 'Chicken breast',
          quantity: '1',
          amount: 2_487,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c3',
          description: 'Berries, 2 lb',
          quantity: '1',
          amount: 849,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c4',
          description: 'Salmon fillet',
          quantity: '1',
          amount: 3_244,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c5',
          description: 'Basmati rice, 20 lb',
          quantity: '1',
          amount: 2_699,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c6',
          description: 'Milk, 2 pack',
          quantity: '1',
          amount: 729,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c7',
          description: 'Avocados, 6 ct',
          quantity: '1',
          amount: 699,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c8',
          description: 'Mixed nuts',
          quantity: '1',
          amount: 1_799,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c9',
          description: 'Greek yogurt',
          quantity: '1',
          amount: 1_507,
          categoryId: 'cat_groceries',
        },
        {
          id: 'li_c10',
          description: 'Paper towels',
          quantity: '1',
          amount: 2_399,
          categoryId: 'cat_household',
        },
        {
          id: 'li_c11',
          description: 'Laundry detergent',
          quantity: '1',
          amount: 1_999,
          categoryId: 'cat_household',
        },
        {
          id: 'li_c12',
          description: 'Trash bags',
          quantity: '1',
          amount: 2_026,
          categoryId: 'cat_household',
        },
      ],
      matchedTransactionId: costco.id,
      status: 'matched',
      aiConfidence: 0.91,
      createdAt: `${costcoDate}T19:30:00.000Z`,
      updatedAt: now,
    },
    {
      id: 'rcp_market',
      r2Key: 'receipts/sample/rcp_market.jpg',
      merchant: 'Farmers market',
      date: addDays(today, -1),
      subtotal: null,
      tax: null,
      tip: null,
      total: 2_400,
      currency: 'USD',
      lineItems: [],
      matchedTransactionId: null,
      status: 'needs_review',
      aiConfidence: 0.62,
      createdAt: `${addDays(today, -1)}T17:00:00.000Z`,
      updatedAt: now,
    },
  ];

  const rules: Rule[] = [
    {
      id: 'rule_rent',
      name: 'Rent to Parkside',
      enabled: true,
      priority: 10,
      match: 'all',
      conditions: [{ field: 'rawName', op: 'contains', value: 'PARKSIDE APTS' }],
      actions: [
        { type: 'set_category', categoryId: 'cat_rent' },
        { type: 'set_name', name: 'Parkside Apartments' },
      ],
      source: 'user',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rule_payroll',
      name: 'Payroll',
      enabled: true,
      priority: 20,
      match: 'all',
      conditions: [{ field: 'rawName', op: 'starts_with', value: 'ACME CORP PAYROLL' }],
      actions: [{ type: 'set_category', categoryId: 'cat_paycheck' }, { type: 'mark_reviewed' }],
      source: 'user',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rule_learned_venmo',
      name: 'Venmo under $50 is dining (learned)',
      enabled: true,
      priority: 100,
      match: 'all',
      conditions: [
        { field: 'rawName', op: 'contains', value: 'VENMO' },
        { field: 'amount', op: 'gt', value: -5_000 },
      ],
      actions: [{ type: 'set_category', categoryId: 'cat_dining' }],
      source: 'learned',
      createdAt: now,
      updatedAt: now,
    },
  ];

  return { transactions, transferLinks: ctx.links, merchants: MERCHANTS, receipts, rules };
}
