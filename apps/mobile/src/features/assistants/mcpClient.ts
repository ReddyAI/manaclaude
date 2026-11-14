import type { McpClientRequest, McpClientResponse } from '@manaclaude/shared';
import { api, BackendError } from '../../data/backend/client';
import { normalizeUrl } from '../../data/backend/config';

/**
 * Connecting an AI assistant to the Worker's MCP server by hand
 * (POST /v1/mcp/clients), for assistants that cannot register themselves.
 * See docs/mcp.md.
 */

export const NAME_MAX = 100;
export const REDIRECTS_MAX = 5;

/** The address to paste into the assistant: the Worker URL plus /mcp. */
export function mcpServerUrl(backendUrl: string): string {
  const base = normalizeUrl(backendUrl);
  return base ? `${base}/mcp` : '';
}

export interface McpClientDraft {
  name: string;
  /** One to five redirect addresses, as typed. */
  redirects: string[];
}

export const EMPTY_DRAFT: McpClientDraft = { name: '', redirects: [''] };

export interface DraftCheck {
  ok: boolean;
  name?: string;
  /** One message per redirect row that has a problem, by index. */
  redirects: Record<number, string>;
  body: McpClientRequest | null;
}

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Why a redirect address can't be used, or null when it can. */
export function redirectProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return 'Paste the redirect address the assistant shows.';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'This is not a web address. It should start with https://';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLocal(url.hostname)) return null;
  return 'Use an https:// address (http:// only for localhost).';
}

/** Checks the form and builds the exact body to send. */
export function checkDraft(draft: McpClientDraft): DraftCheck {
  const redirects: Record<number, string> = {};
  const name = draft.name.trim();
  let nameProblem: string | undefined;
  if (!name) nameProblem = 'Give the assistant a name, for example "Perplexity".';
  else if (name.length > NAME_MAX) nameProblem = `At most ${NAME_MAX} characters.`;
  const seen = new Set<string>();
  draft.redirects.forEach((r, i) => {
    const problem = redirectProblem(r);
    if (problem) redirects[i] = problem;
    else if (seen.has(r.trim())) redirects[i] = 'This address is already in the list.';
    seen.add(r.trim());
  });
  if (draft.redirects.length === 0)
    redirects[0] = 'Paste the redirect address the assistant shows.';
  if (draft.redirects.length > REDIRECTS_MAX) redirects[REDIRECTS_MAX] = 'At most 5 addresses.';
  const ok = !nameProblem && Object.keys(redirects).length === 0;
  return {
    ok,
    name: nameProblem,
    redirects,
    body: ok ? { name, redirectUris: draft.redirects.map((r) => r.trim()) } : null,
  };
}

export type CreateFailure =
  /** Nothing was made, for certain. */
  | { kind: 'refused'; text: string }
  /** The answer was lost: a client may exist on the Worker. */
  | { kind: 'unknown'; text: string };

export const NOT_CONFIGURED_TEXT =
  "Your Worker can't make assistant clients: its sign-in for assistants (OAuth) is not running, so nothing was made. Deploy the Worker with the steps in docs/setup.md, then try again.";

export const LOST_TEXT =
  "The answer from your Worker didn't arrive, so a client may have been made anyway. Nothing was sent again. If the assistant still needs a client ID and secret, make one more on purpose; an unused client does no harm, since nobody has its secret.";

export const SUPERSEDED_TEXT =
  'The backend changed while the client was being made, so its answer was dropped. A client may have been made on the previous backend. Nothing was sent again.';

/** Turns an error from the route into what the screen says. */
export function createFailure(e: unknown): CreateFailure {
  if (e instanceof BackendError) {
    if (e.superseded) return { kind: 'unknown', text: SUPERSEDED_TEXT };
    if (e.status === 503 && e.code === 'not_configured')
      return { kind: 'refused', text: NOT_CONFIGURED_TEXT };
    // No answer, or the server failed somewhere we can't see: it may have made one.
    if (e.status === 0 || e.status >= 500) return { kind: 'unknown', text: LOST_TEXT };
    return { kind: 'refused', text: `Nothing was made. ${e.message}` };
  }
  return { kind: 'unknown', text: LOST_TEXT };
}

/** POST /v1/mcp/clients, sent once. The answer holds the secret: never store or log it. */
export function createMcpClient(body: McpClientRequest): Promise<McpClientResponse> {
  return api<McpClientResponse>('POST', '/v1/mcp/clients', body);
}
