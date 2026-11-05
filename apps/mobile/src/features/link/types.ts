/** What every link flow gets: the connection to repair (if any) and what to call when a login is saved. */
export interface FlowProps {
  connector: string;
  connectionId?: string;
  onLinked: (connectionIds: string[], repaired: boolean) => void;
}
