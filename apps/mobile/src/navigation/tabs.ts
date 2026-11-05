import type { IconName } from '../design/components/Icon';

export interface TabDef {
  /** Route file name under src/app/(tabs)/. */
  name: string;
  title: string;
  icon: IconName;
  /** Shown in the phone's bottom bar; the rest go under "More". */
  primary: boolean;
}

/**
 * The seven main screens. Wide screens (web, tablets) show all of them in a
 * sidebar; phones show the primary four plus "More".
 */
export const TABS: readonly TabDef[] = [
  { name: 'index', title: 'Home', icon: 'layout-dashboard', primary: true },
  { name: 'transactions', title: 'Transactions', icon: 'list', primary: true },
  { name: 'budgets', title: 'Budgets', icon: 'chart-pie', primary: true },
  { name: 'networth', title: 'Net worth', icon: 'chart-line', primary: true },
  { name: 'recurring', title: 'Recurring', icon: 'calendar', primary: false },
  { name: 'accounts', title: 'Accounts', icon: 'wallet', primary: false },
  { name: 'settings', title: 'Settings', icon: 'settings', primary: false },
];
