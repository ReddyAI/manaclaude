import { createPlaidLinkSession } from 'react-native-plaid-link-sdk';

/**
 * Plaid Link on Android through react-native-plaid-link-sdk (v13 sessions).
 * Resolves with the public token, or null when the person closed Link.
 * (The web build uses plaidLink.web.ts, Plaid's own web Link.)
 */
export function openPlaidLink(
  linkToken: string,
): Promise<{ publicToken: string; institutionName: string | null } | null> {
  return new Promise((resolve, reject) => {
    createPlaidLinkSession({
      token: linkToken,
      onSuccess: (s) =>
        resolve({
          publicToken: s.publicToken,
          institutionName: s.metadata.institution?.name ?? null,
        }),
      onExit: () => resolve(null),
      onEvent: () => {},
    })
      .then((session) => session.open())
      .catch(reject);
  });
}
