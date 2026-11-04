import { describe, expect, it } from 'vitest';
import type { FxRate } from '../src';
import {
  addDec,
  cmpDec,
  convertAmount,
  convertMinor,
  divDec,
  findRate,
  fromScaled,
  impliedRateOf,
  mulDec,
  proRateMinor,
  subDec,
  toScaled,
  valueInMinor,
} from '../src';

describe('decimal helpers', () => {
  it('adds and subtracts exactly', () => {
    expect(addDec('0.1', '0.2')).toBe('0.3');
    expect(subDec('0.15', '0.05')).toBe('0.1');
    expect(subDec('1', '1.5')).toBe('-0.5');
    expect(addDec('0.00000001', '0.00000002')).toBe('0.00000003');
  });

  it('multiplies, divides and compares', () => {
    expect(mulDec('5', '10')).toBe('50');
    expect(mulDec('0.15', '2')).toBe('0.3');
    expect(divDec('1', '3')).toBe('0.333333333333');
    expect(cmpDec('2', '10')).toBe(-1);
    expect(fromScaled(toScaled('-0.000'))).toBe('0');
  });

  it('values a position in minor units', () => {
    expect(valueInMinor('12.5', '100.10', 'USD')).toBe(125125);
    expect(valueInMinor('0.15', '104250', 'USD')).toBe(1563750);
    expect(valueInMinor('3', '0.333', 'USD')).toBe(100);
  });

  it('pro-rates cost basis', () => {
    expect(proRateMinor(400240, '12', '20')).toBe(240144);
    expect(proRateMinor(100, '1', '3')).toBe(33);
  });
});

const rates: FxRate[] = [
  { base: 'USD', quote: 'INR', rate: 87.5, asOf: '2026-10-01T14:00:00.000Z', date: '2026-10-01', source: 'frankfurter_ecb' },
  { base: 'USD', quote: 'INR', rate: 88.0, asOf: '2026-10-15T14:00:00.000Z', date: '2026-10-15', source: 'frankfurter_ecb' },
  { base: 'USD', quote: 'INR', rate: 88.4, asOf: '2026-11-04T10:00:00.000Z', date: '2026-11-04', source: 'openexchangerates' },
  { base: 'USD', quote: 'EUR', rate: 0.9, asOf: '2026-11-04T10:00:00.000Z', date: '2026-11-04', source: 'openexchangerates' },
];

describe('FX conversion', () => {
  it('uses the latest rate for balances', () => {
    expect(findRate(rates, 'USD', 'INR')?.rate).toBe(88.4);
    expect(convertAmount(100_00, 'USD', 'INR', rates)).toBe(8840_00);
  });

  it('uses the rate on the transaction date for reports', () => {
    expect(findRate(rates, 'USD', 'INR', { mode: 'on', date: '2026-10-20' })?.rate).toBe(88.0);
    expect(findRate(rates, 'USD', 'INR', { mode: 'on', date: '2026-10-01' })?.rate).toBe(87.5);
    // Before the first known rate: fall back to the oldest.
    expect(findRate(rates, 'USD', 'INR', { mode: 'on', date: '2026-01-01' })?.rate).toBe(87.5);
  });

  it('inverts and crosses through USD', () => {
    expect(convertAmount(8840_00, 'INR', 'USD', rates)).toBe(100_00);
    const eurInr = findRate(rates, 'EUR', 'INR');
    expect(eurInr?.rate).toBeCloseTo(88.4 / 0.9, 6);
    expect(convertAmount(500, 'GBP', 'USD', rates)).toBeNull();
  });

  it('handles currencies with different minor digits', () => {
    expect(convertMinor(1000, 'USD', 'JPY', 150)).toBe(1500);
  });

  it('derives the implied rate of a cross-currency transfer', () => {
    expect(impliedRateOf(-200_000, 'USD', 17_624_000, 'INR')).toBeCloseTo(88.12, 6);
  });
});
