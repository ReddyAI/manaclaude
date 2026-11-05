/**
 * Worker bindings and secrets. Session B adds DB (D1), FILES (R2), AI and
 * TELLER_CERT here when the bindings in wrangler.toml are turned on.
 */
export interface Env {
  /** Open Exchange Rates app ID (Worker secret). */
  OXR_APP_ID?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}
