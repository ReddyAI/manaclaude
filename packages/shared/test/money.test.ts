import { describe, expect, it } from 'vitest';
import {
  MINUS,
  allocate,
  formatMoney,
  formatRate,
  fromMajor,
  parseMoneyInput,
  toMajor,
} from '../src';

describe('formatMoney', () => {
  it('formats USD with western grouping', () => {
    expect(formatMoney(123456, 'USD')).toBe('$1,234.56');
    expect(formatMoney(5, 'USD')).toBe('$0.05');
    expect(formatMoney(0, 'USD')).toBe('$0.00');
    expect(formatMoney(-123456789, 'USD')).toBe(`${MINUS}$1,234,567.89`);
  });

  it('formats INR with lakh and crore grouping', () => {
    expect(formatMoney(12345678, 'INR')).toBe('₹1,23,456.78');
    expect(formatMoney(1234567800, 'INR')).toBe('₹1,23,45,678.00');
    expect(formatMoney(99900, 'INR')).toBe('₹999.00');
  });

  it('supports sign, cents and compact options', () => {
    expect(formatMoney(421538, 'USD', { sign: 'always' })).toBe('+$4,215.38');
    expect(formatMoney(-421538, 'USD', { sign: 'never' })).toBe('$4,215.38');
    expect(formatMoney(1234567, 'USD', { cents: 'auto' })).toBe('$12,346');
    expect(formatMoney(999999, 'USD', { cents: 'auto' })).toBe('$9,999.99');
    expect(formatMoney(1234567, 'USD', { compact: true })).toBe('$12.3K');
    expect(formatMoney(250_000_000, 'USD', { compact: true })).toBe('$2.5M');
    expect(formatMoney(1234567800, 'INR', { compact: true })).toBe('₹1.23Cr');
    expect(formatMoney(25_000_000, 'INR', { compact: true })).toBe('₹2.5L');
    expect(formatMoney(4200, 'USD', { compact: true })).toBe('$42');
    expect(formatMoney(123456, 'USD', { code: true })).toBe('1,234.56 USD');
  });

  it('handles zero-decimal currencies', () => {
    expect(formatMoney(1500, 'JPY')).toBe('¥1,500');
  });

  it('formats a rate label', () => {
    expect(formatRate(88.4213, 'USD', 'INR')).toBe('1 USD = 88.4213 INR');
    expect(formatRate(0.01131, 'INR', 'USD')).toBe('1 INR = 0.011310 USD');
  });
});

describe('parsing and conversion between major and minor units', () => {
  it('parses typed amounts into minor units', () => {
    expect(parseMoneyInput('1,234.5', 'USD')).toBe(123450);
    expect(parseMoneyInput('₹1,00,000', 'INR')).toBe(10_000_000);
    expect(parseMoneyInput('-12', 'USD')).toBe(-1200);
    expect(parseMoneyInput('.99', 'USD')).toBe(99);
    expect(parseMoneyInput('12.345', 'USD')).toBeNull();
    expect(parseMoneyInput('abc', 'USD')).toBeNull();
    expect(parseMoneyInput('', 'USD')).toBeNull();
  });

  it('round-trips major units without float drift', () => {
    expect(fromMajor(0.1 + 0.2, 'USD')).toBe(30);
    expect(fromMajor(19.99, 'USD')).toBe(1999);
    expect(fromMajor(-2.675, 'USD')).toBe(-268);
    expect(toMajor(1999, 'USD')).toBeCloseTo(19.99);
  });
});

describe('allocate', () => {
  it('always adds up to the total', () => {
    expect(allocate(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(allocate(-10000, [1, 1, 1])).toEqual([-3334, -3333, -3333]);
    expect(allocate(21436, [15012, 6424])).toEqual([15012, 6424]);
    const parts = allocate(99999, [0.2, 0.3, 0.5]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(99999);
  });

  it('rejects bad input', () => {
    expect(() => allocate(1.5, [1])).toThrow();
    expect(() => allocate(100, [])).toThrow();
    expect(() => allocate(100, [0, 0])).toThrow();
  });
});
