/**
 * Kite Connect login (https://kite.trade/docs/connect/v3/user/): the browser
 * goes to Kite's login page with the app's api_key; after the person signs in,
 * Kite redirects to the redirect URL registered for the app with
 * request_token, action=login, status=success, plus whatever was passed in
 * redirect_params. The backend passes a signed `state` that way, then turns
 * the request_token into the day's access token with exchangeKiteRequestToken().
 *
 * The api_key is an app identifier that Kite itself shows in this URL; the
 * api_secret never leaves the Worker.
 */
export function kiteLoginUrl(apiKey: string, state: string): string {
  const redirectParams = new URLSearchParams({ state }).toString();
  const q = new URLSearchParams({ v: '3', api_key: apiKey, redirect_params: redirectParams });
  return `https://kite.zerodha.com/connect/login?${q.toString()}`;
}
