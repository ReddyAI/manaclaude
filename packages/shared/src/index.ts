/**
 * @manaclaude/shared: the one data model used by the app, the backend and the
 * connectors. Change it only with small, additive edits (see CLAUDE.md).
 *
 * Sample data lives in "@manaclaude/shared/sample" so production bundles can
 * leave it out.
 */
export * from './model';
export * from './money/currencies';
export * from './money/money';
export * from './money/format';
export * from './money/decimal';
export * from './dates/dates';
export * from './fx/convert';
export * from './policy/treatment';
export * from './policy/summary';
export * from './policy/split';
export * from './investments/lots';
export * from './investments/gains';
export * from './planning/budgets';
export * from './planning/fire';
export * from './planning/recap';
export * from './planning/recurring';
