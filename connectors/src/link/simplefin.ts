import type { ConnectorContext } from '@manaclaude/shared';
import { LinkInputError, ProviderHttpError } from '../errors';

/**
 * SimpleFIN setup token to access URL (https://www.simplefin.org/protocol.html),
 * as Sure does it (provider/simplefin.rb, claim_access_url): the setup token is
 * the base64 of a one-time claim URL; an empty POST to it answers with the
 * access URL as plain text. The access URL carries its own user name and
 * password, so it is a credential: the caller stores it encrypted and never
 * shows it. A setup token works once; a second claim answers 403.
 */
export async function claimSimplefinSetupToken(
  ctx: ConnectorContext,
  setupToken: string,
): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  let res: Awaited<ReturnType<ConnectorContext['fetch']>>;
  try {
    res = await ctx.fetch(claimUrl, {
      method: 'POST',
      headers: { 'User-Agent': 'Billionaire', 'Content-Length': '0' },
      body: '',
    });
  } catch {
    throw new ProviderHttpError('SimpleFIN', 0);
  }
  if (res.status === 403) {
    throw new LinkInputError(
      'This setup token was already used or has expired. Make a new one at SimpleFIN Bridge and paste it again.',
    );
  }
  if (!res.ok) throw new ProviderHttpError('SimpleFIN', res.status);
  const accessUrl = (await res.text()).trim();
  if (!isAccessUrl(accessUrl)) {
    throw new LinkInputError('SimpleFIN answered with something that is not an access URL.');
  }
  return accessUrl;
}

/** The claim URL inside a setup token, or a LinkInputError for anything else. */
export function decodeSetupToken(setupToken: string): string {
  const compact = setupToken.replace(/\s+/g, '');
  let decoded = '';
  try {
    decoded = atob(compact.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    decoded = '';
  }
  let url: URL | null = null;
  try {
    url = new URL(decoded);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || !url.hostname.includes('.')) {
    throw new LinkInputError(
      'That is not a SimpleFIN setup token. Copy the long token from SimpleFIN Bridge and paste it again.',
    );
  }
  return url.toString();
}

function isAccessUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.username !== '' && url.password !== '';
  } catch {
    return false;
  }
}
