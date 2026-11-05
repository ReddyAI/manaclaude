import { ConnectorRepairNeededError } from '@manaclaude/shared';

export { ConnectorRepairNeededError };

/**
 * A provider answered with an error status. The message is safe to show in the
 * app (it never contains the response body); `detail` keeps a trimmed copy of
 * the body for logs only.
 */
export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly detail: string;
  constructor(provider: string, status: number, detail = '') {
    super(`${provider} request failed (HTTP ${status})`);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.status = status;
    this.detail = detail.slice(0, 500);
  }
}

/** HTTP 429 or a provider's own rate-limit answer. Retry later; no repair needed. */
export class ConnectorRateLimitedError extends ProviderHttpError {
  readonly retryAfterSeconds: number | null;
  constructor(provider: string, retryAfterSeconds: number | null, detail = '') {
    super(provider, 429, detail);
    this.name = 'ConnectorRateLimitedError';
    this.message = `${provider} rate limit reached; try again later`;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The Worker lacks an app-level key (client id, API secret). The user cannot fix this by repairing a login. */
export class ConnectorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorConfigError';
  }
}

/** The provider answered 200 but the body is not shaped the way its docs say. */
export class ProviderDataError extends Error {
  constructor(provider: string, what: string) {
    super(`${provider} sent an unexpected response (${what})`);
    this.name = 'ProviderDataError';
  }
}

/** Repair error with the standard wording the app shows next to the Repair button. */
export function repairNeeded(provider: string, why = 'login expired'): ConnectorRepairNeededError {
  return new ConnectorRepairNeededError(`${provider}: ${why}. Repair the connection to continue.`);
}
