/**
 * Plaid's web Link (https://plaid.com/docs/link/web/): its script from
 * cdn.plaid.com, loaded only when you link a bank with Plaid.
 */
interface PlaidHandler {
  open: () => void;
  destroy: () => void;
}
interface PlaidGlobal {
  create: (config: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => void;
    onExit: () => void;
  }) => PlaidHandler;
}

const SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

function loadScript(): Promise<PlaidGlobal> {
  const existing = (globalThis as { Plaid?: PlaidGlobal }).Plaid;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = SCRIPT;
    tag.async = true;
    tag.onload = () => {
      const plaid = (globalThis as { Plaid?: PlaidGlobal }).Plaid;
      if (plaid) resolve(plaid);
      else reject(new Error('Plaid Link did not load.'));
    };
    tag.onerror = () => reject(new Error('Plaid Link did not load.'));
    document.head.appendChild(tag);
  });
}

export async function openPlaidLink(
  linkToken: string,
): Promise<{ publicToken: string; institutionName: string | null } | null> {
  const plaid = await loadScript();
  return new Promise((resolve) => {
    const handler = plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => {
        handler.destroy();
        resolve({ publicToken, institutionName: metadata.institution?.name ?? null });
      },
      onExit: () => {
        handler.destroy();
        resolve(null);
      },
    });
    handler.open();
  });
}
