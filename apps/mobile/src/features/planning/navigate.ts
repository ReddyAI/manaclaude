/**
 * Navigation helpers for session C's screens. expo-router loads lazily so
 * components that only link somewhere (settings, budgets) can render in Jest
 * without pulling in the navigator.
 */
type Router = typeof import('expo-router').router;

function withRouter(run: (router: Router) => void): void {
  import('expo-router').then((m) => run(m.router)).catch(() => {});
}

export function goTo(path: string): void {
  withRouter((r) => r.push(path as never));
}

export function goReplace(path: string): void {
  withRouter((r) => r.replace(path as never));
}

export function goBack(fallback: string): void {
  withRouter((r) => (r.canGoBack() ? r.back() : r.replace(fallback as never)));
}
