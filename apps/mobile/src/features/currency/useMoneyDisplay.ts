import { useMemo } from 'react';
import {
  convertAmount,
  findRate,
  type CurrencyCode,
  type DisplayCurrencyMode,
  type LocalDate,
  type MinorUnits,
  type Money,
  type ResolvedRate,
} from '@manaclaude/shared';
import { useSettings } from '../../data/settingsStore';
import { useFinanceSelector } from '../../data/store';

/**
 * Display-currency logic for every screen (session C owns this file).
 *
 * - USD / INR: convert to that currency. Balances use the latest rate; pass
 *   `date` for transactions so reports use the rate on that day.
 * - BOTH: the primary currency large, the secondary underneath.
 * - NATIVE: each amount in its own currency; totals use the primary currency.
 */

export interface DisplayAmount {
  main: Money;
  /** The other currency in BOTH mode. */
  sub: Money | null;
  /** True when no rate was found and the amount is shown unconverted. */
  unconverted: boolean;
}

export interface MoneyItem {
  amount: MinorUnits;
  currency: CurrencyCode;
  date?: LocalDate;
}

export interface MoneyDisplay {
  mode: DisplayCurrencyMode;
  /** Currency used for totals and charts. */
  reportCurrency: CurrencyCode;
  primaryCurrency: CurrencyCode;
  secondaryCurrency: CurrencyCode;
  present(amount: MinorUnits, currency: CurrencyCode, date?: LocalDate): DisplayAmount;
  /** Sum mixed-currency amounts into one currency (report currency by default). */
  total(items: readonly MoneyItem[], into?: CurrencyCode): Money;
  convert(
    amount: MinorUnits,
    from: CurrencyCode,
    to: CurrencyCode,
    date?: LocalDate,
  ): MinorUnits | null;
  /** Latest primary-to-secondary rate, for the chip's long-press. */
  latestRate: ResolvedRate | null;
}

export function useMoneyDisplay(): MoneyDisplay {
  const { displayCurrencyMode: mode, primaryCurrency, secondaryCurrency } = useSettings();
  const rates = useFinanceSelector((d) => d.fxRates);

  return useMemo(() => {
    const reportCurrency = mode === 'INR' ? 'INR' : mode === 'USD' ? 'USD' : primaryCurrency;
    const convert = (amount: MinorUnits, from: CurrencyCode, to: CurrencyCode, date?: LocalDate) =>
      convertAmount(amount, from, to, rates, date ? { mode: 'on', date } : { mode: 'latest' });

    const present = (
      amount: MinorUnits,
      currency: CurrencyCode,
      date?: LocalDate,
    ): DisplayAmount => {
      if (mode === 'NATIVE') return { main: { amount, currency }, sub: null, unconverted: false };
      if (mode === 'BOTH') {
        const main = convert(amount, currency, primaryCurrency, date);
        const sub = convert(amount, currency, secondaryCurrency, date);
        if (main === null) return { main: { amount, currency }, sub: null, unconverted: true };
        return {
          main: { amount: main, currency: primaryCurrency },
          sub: sub === null ? null : { amount: sub, currency: secondaryCurrency },
          unconverted: false,
        };
      }
      const converted = convert(amount, currency, mode, date);
      if (converted === null) return { main: { amount, currency }, sub: null, unconverted: true };
      return { main: { amount: converted, currency: mode }, sub: null, unconverted: false };
    };

    const total = (items: readonly MoneyItem[], into: CurrencyCode = reportCurrency): Money => {
      let sum = 0;
      for (const it of items) sum += convert(it.amount, it.currency, into, it.date) ?? 0;
      return { amount: sum, currency: into };
    };

    return {
      mode,
      reportCurrency,
      primaryCurrency,
      secondaryCurrency,
      present,
      total,
      convert,
      latestRate: findRate(rates, primaryCurrency, secondaryCurrency),
    };
  }, [mode, primaryCurrency, secondaryCurrency, rates]);
}
