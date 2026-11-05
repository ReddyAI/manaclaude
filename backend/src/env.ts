import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/** Minimal shape of the Workers AI binding that this Worker uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
  toMarkdown?(
    files: { name: string; blob: Blob }[],
  ): Promise<{ name: string; mimeType: string; format: string; data?: string; error?: string }[]>;
}

/**
 * Worker bindings, plain vars and secrets. Secrets are set with
 * `wrangler secret put NAME` (production) or `.dev.vars` (local); their names
 * are listed in .dev.vars.example. None of them are ever logged.
 */
export interface Env {
  DB: D1Database;
  /** Receipt images and the statement vault. */
  FILES: R2Bucket;
  /** Workers AI. */
  AI?: AiBinding;
  /** OAuth grants and tokens for the MCP server. */
  OAUTH_KV?: KVNamespace;
  /** Injected by workers-oauth-provider. */
  OAUTH_PROVIDER?: OAuthHelpers;

  // Secrets
  /** Bearer token the app sends to /v1. */
  APP_API_TOKEN?: string;
  /** Password Sankar types on the MCP sign-in page. */
  MCP_OWNER_PASSWORD?: string;
  /** Open Exchange Rates app ID. */
  OXR_APP_ID?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Paid Gemini API key (never the free tier). */
  GEMINI_API_KEY?: string;

  // Plain vars (wrangler.toml [vars])
  /** OpenAI-compatible endpoint, for the openai_compatible provider. */
  OPENAI_BASE_URL?: string;
  AI_TEXT_MODEL?: string;
  AI_VISION_MODEL?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
  /** Daily cap on Workers AI calls, to stay inside the free allowance. */
  AI_DAILY_CALL_LIMIT?: string;
  /** "true" lets POST /v1/dev/seed load the invented sample data (local only). */
  ALLOW_SAMPLE_SEED?: string;
  /** Public base URL of this Worker (https://manaclaude-api.<you>.workers.dev). The MCP resource is PUBLIC_URL/mcp. */
  PUBLIC_URL?: string;
  /** Allowed browser origin for the web app (CORS). "*" in local dev. */
  APP_ORIGIN?: string;
}
