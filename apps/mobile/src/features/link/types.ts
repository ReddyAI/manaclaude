/** What every link flow gets: the connection to repair (if any) and what to call when a login is saved. */
export interface FlowProps {
  connector: string;
  connectionId?: string;
  onLinked: (connectionIds: string[], repaired: boolean) => void;
}

/** Ends a message with a full stop, so another sentence can follow it. */
export function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
