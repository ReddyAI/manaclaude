import { todayLocal } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { getFinance } from '../store';

/**
 * The app's tests run with a fixed clock (jest.config.js), so nothing that
 * reads "today" depends on the day the tests happen to run.
 */
describe('the test clock', () => {
  it('is fixed at 5 November 2026, noon UTC', () => {
    expect(new Date().toISOString()).toBe('2026-11-05T12:00:00.000Z');
    expect(Date.now()).toBe(Date.parse('2026-11-05T12:00:00.000Z'));
    expect(todayLocal()).toBe('2026-11-05');
  });

  it('does not move while a test waits on a real timer', async () => {
    const before = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Date.now()).toBe(before);
  });

  it('dates the sample data from that day, including the data the store starts with', () => {
    const newest = (list: readonly { date: string }[]) =>
      list.reduce((max, t) => (t.date > max ? t.date : max), '');
    expect(newest(createSampleData().transactions)).toBe('2026-11-05');
    expect(newest(getFinance().transactions)).toBe('2026-11-05');
    expect(createSampleData().budgets.every((b) => b.month <= '2026-11')).toBe(true);
  });

  it('can be moved by one test without leaking into the next', () => {
    jest.setSystemTime(new Date('2027-02-01T12:00:00.000Z'));
    expect(todayLocal()).toBe('2027-02-01');
    jest.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
  });
});
