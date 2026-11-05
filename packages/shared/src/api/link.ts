/**
 * Account linking (session E2): request and response types for /v1/link/*.
 * Every response holds ids, statuses and names only. Bank passwords, tokens,
 * API keys and access URLs go in, are stored encrypted by the Worker, and are
 * never sent back.
 */
import type { Id } from '../model/common';
import type { ConnectionStatus } from '../model/connector';

export type LinkKind = 'bank' | 'brokerage' | 'crypto';

export interface LinkConnectorOption {
  id: string;
  name: string;
  /** The Worker has the app-level keys this connector needs (never their values). */
  configured: boolean;
  /** Why it can't be used right now, in plain words; null when it can. */
  blockedReason: string | null;
  slots: { total: number | null; used: number; left: number | null; lifetime: boolean };
}

/** GET /v1/link/options */
export interface LinkOptionsResponse {
  /** Connector ids in the order to try them, per kind. */
  order: Record<LinkKind, string[]>;
  connectors: LinkConnectorOption[];
  /** Plaid stays off until the owner turns it on (PLAID_LINK_ENABLED). */
  plaidEnabled: boolean;
  /** CREDENTIALS_SECRET is set, so logins can be saved. */
  credentialsReady: boolean;
}

/** The answer of every flow that ends with a saved login. */
export interface LinkDoneResponse {
  connectionIds: Id[];
  /** True when an existing connection was repaired (same id, same accounts, no new slot). */
  repaired: boolean;
}

/** POST /v1/link/sophtron/institutions */
export interface SophtronInstitutionsRequest {
  query: string;
}
export interface SophtronInstitutionsResponse {
  institutions: { id: string; name: string; url: string | null }[];
}

/**
 * POST /v1/link/sophtron/start. A new login sends the bank's sign-in details
 * once. A repair sends `connectionId` and either `refresh: true` (answer the
 * bank's question again, same login) or new sign-in details.
 */
export interface SophtronStartRequest {
  institutionId?: string;
  institutionName?: string;
  username?: string;
  password?: string;
  pin?: string;
  connectionId?: Id;
  refresh?: boolean;
}

export interface LinkChallenge {
  securityQuestions: string[];
  tokenMethods: string[];
  tokenSent: boolean;
  tokenRead: string | null;
  captchaImage: string | null;
}

/** POST /v1/link/sophtron/start and GET /v1/link/sophtron/:linkId */
export interface SophtronLinkStatus {
  linkId: Id;
  status: 'pending' | 'mfa' | 'done' | 'failed';
  challenge?: LinkChallenge;
  message?: string;
  connectionIds?: Id[];
  repaired?: boolean;
}

/** POST /v1/link/sophtron/:linkId/answer */
export type SophtronAnswerRequest =
  | { type: 'security_answer'; answers: string[] }
  | { type: 'token_choice'; choice: string }
  | { type: 'token_input'; code: string }
  | { type: 'verify_phone' }
  | { type: 'captcha'; text: string };

/** POST /v1/link/simplefin */
export interface SimplefinLinkRequest {
  setupToken: string;
  connectionId?: Id;
}

/** POST /v1/link/snaptrade/start and /v1/link/zerodha_kite/start */
export interface BrowserLinkRequest {
  connectionId?: Id;
  /** Where the browser goes when it is done: billionaire://... on the phone, the web app's address on the web. */
  returnUrl?: string;
}
export interface BrowserLinkResponse {
  linkId: Id;
  /** Open this in a browser (the SnapTrade portal, the Kite login page). */
  url: string;
}

/** POST /v1/link/plaid/link-token */
export interface PlaidLinkTokenRequest {
  platform: 'android' | 'ios' | 'web';
  connectionId?: Id;
}
export interface PlaidLinkTokenResponse {
  linkToken: string;
  expiration: string | null;
}

/** POST /v1/link/plaid/exchange. Update mode (repair) sends only connectionId. */
export interface PlaidExchangeRequest {
  publicToken?: string;
  institutionName?: string;
  connectionId?: Id;
}

/** POST /v1/link/keys: exchanges that sign with an API key and secret. */
export interface KeyLinkRequest {
  connectorId: 'coinbase' | 'wazirx';
  apiKey: string;
  apiSecret: string;
  connectionId?: Id;
}

/** POST /v1/connections/:id/sync */
export interface ConnectionSyncResponse {
  connectionId: Id;
  connectorId: string;
  outcome: 'ok' | 'needs_repair' | 'error' | 'skipped';
  /** A long first sync wrote part of its rows: call again. */
  more: boolean;
  status: ConnectionStatus;
  error: string | null;
  summary: {
    accountsCreated: number;
    inserted: number;
    updated: number;
    removed: number;
    remaining: number;
    more: boolean;
  } | null;
}
