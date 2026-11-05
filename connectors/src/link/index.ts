/**
 * Provider calls for linking a new login (session E2). Each helper takes a
 * ConnectorContext like the adapters, so tests run them against invented
 * responses through a fake fetch. The backend stores what they return with
 * saveCredentials and never echoes it.
 */
export * from './sophtron';
export * from './simplefin';
export * from './snaptrade';
export * from './plaid';
export * from './zerodha';
export { exchangeKiteRequestToken } from '../adapters/zerodha_kite';
