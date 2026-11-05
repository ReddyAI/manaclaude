import { useMemo } from 'react';
import {
  convertAmount,
  convertMinor,
  findRate,
  transferRate,
  type CurrencyCode,
  type DisplayCurrencyMode,
  type LocalDate,
  type MinorUnits,
  type Money,
  type ResolvedRate,
  type TransferLink,
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
 * - A linked cross-currency transfer passes its `link` and converts with the
 *   rate it actually got (the link's implied rate) instead of the market rate.
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
  link?: TransferLink | null;
}

export interface MoneyDisplay {
  mode: DisplayCurrencyMode;
  /** Currency used for totals and charts. */
  reportCurrency: CurrencyCode;
  primaryCurrency: CurrencyCode;
  secondaryCurrency: CurrencyCode;
  present(
    amount: MinorUnits,
    currency: CurrencyCode,
    date?: LocalDate,
    link?: TransferLink | null,
  ): DisplayAmount;
  /** The second currency in BOTH mode, otherwise null. */
  subCurrency: CurrencyCode | null;
  /**
   * Run a report once per shown currency. In BOTH mode the secondary result is
   * computed on its own (spending uses each transaction's day rate in that
   * currency) instead of converting the primary total.
   */
  dual<T>(compute: (currency: CurrencyCode) => T): { main: T; sub: T | null };
  /** Sum mixed-currency amounts into one currency (report currency by default). */
  total(items: readonly MoneyItem[], into?: CurrencyCode): Money;
  convert(
    amount: MinorUnits,
    from: CurrencyCode,
    to: CurrencyCode,
    date?: LocalDate,
    link?: TransferLink | null,
  ): MinorUnits | null;
  /** Latest primary-to-secondary rate, for the chip's long-press. */
  latestRate: ResolvedRate | null;
}

export function useMoneyDisplay(): MoneyDisplay {
  const { displayCurrencyMode: mode, primaryCurrency, secondaryCurrency } = useSettings();
  const rates = useFinanceSelector((d) => d.fxRates);

  return useMemo(() => {
    const reportCurrency = mode === 'INR' ? 'INR' : mode === 'USD' ? 'USD' : primaryCurrency;
    const convert = (
      amount: MinorUnits,
      from: CurrencyCode,
      to: CurrencyCode,
      date?: LocalDate,
      link?: TransferLink | null,
    ) => {
      if (link && from !== to) {
        const own = transferRate(link, from, to);
        if (own !== null) return convertMinor(amount, from, to, own);
      }
      return convertAmount(
        amount,
        from,
        to,
        rates,
        date ? { mode: 'on', date } : { mode: 'latest' },
      );
    };

    const present = (
      amount: MinorUnits,
      currency: CurrencyCode,
      date?: LocalDate,
      link?: TransferLink | null,
    ): DisplayAmount => {
      if (mode === 'NATIVE') return { main: { amount, currency }, sub: null, unconverted: false };
      if (mode === 'BOTH') {
        const main = convert(amount, currency, primaryCurrency, date, link);
        const sub = convert(amount, currency, secondaryCurrency, date, link);
        if (main === null) return { main: { amount, currency }, sub: null, unconverted: true };
        return {
          main: { amount: main, currency: primaryCurrency },
          sub: sub === null ? null : { amount: sub, currency: secondaryCurrency },
          unconverted: false,
        };
      }
      const converted = convert(amount, currency, mode, date, link);
      if (converted === null) return { main: { amount, currency }, sub: null, unconverted: true };
      return { main: { amount: converted, currency: mode }, sub: null, unconverted: false };
    };

    const total = (items: readonly MoneyItem[], into: CurrencyCode = reportCurrency): Money => {
      let sum = 0;
      for (const it of items) sum += convert(it.amount, it.currency, into, it.date, it.link) ?? 0;
      return { amount: sum, currency: into };
    };

    const subCurrency = mode === 'BOTH' ? secondaryCurrency : null;
    const dual = <T>(compute: (currency: CurrencyCode) => T) => ({
      main: compute(reportCurrency),
      sub: subCurrency ? compute(subCurrency) : null,
    });

    return {
      mode,
      subCurrency,
      dual,
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

/**
 * Pick one number out of a `display.dual(...)` result, ready to spread into
 * `<DualAmount {...pickDual(display, report, (r) => r.total)} />`.
 */
export function pickDual<T>(
  display: Pick<MoneyDisplay, 'subCurrency'>,
  pair: { main: T; sub: T | null },
  pick: (value: T) => MinorUnits,
): { main: MinorUnits; sub: Money | null } {
  return {
    main: pick(pair.main),
    sub:
      pair.sub !== null && display.subCurrency
        ? { amount: pick(pair.sub), currency: display.subCurrency }
        : null,
  };
}
