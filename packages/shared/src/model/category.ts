import type { ColorSlot, Id } from './common';

/**
 * expense: spending categories (refunds into them reduce spending)
 * income: paychecks, interest, dividends
 * transfer: categories that never count as spending or income
 */
export type CategoryKind = 'expense' | 'income' | 'transfer';

/** Icon key. The app maps each key to an icon from its own icon set. */
export type CategoryIcon =
  | 'home'
  | 'utensils'
  | 'shopping-cart'
  | 'coffee'
  | 'car'
  | 'fuel'
  | 'bus'
  | 'plane'
  | 'heart-pulse'
  | 'pill'
  | 'film'
  | 'music'
  | 'gamepad'
  | 'zap'
  | 'wifi'
  | 'phone'
  | 'gift'
  | 'book'
  | 'graduation-cap'
  | 'briefcase'
  | 'banknote'
  | 'trending-up'
  | 'percent'
  | 'landmark'
  | 'piggy-bank'
  | 'repeat'
  | 'credit-card'
  | 'shield'
  | 'shopping-bag'
  | 'shirt'
  | 'scissors'
  | 'dumbbell'
  | 'paw-print'
  | 'baby'
  | 'wrench'
  | 'receipt'
  | 'globe'
  | 'tag'
  | 'sparkles'
  | 'circle';

export interface CategoryGroup {
  id: Id;
  name: string;
  kind: CategoryKind;
  order: number;
}

export interface Category {
  id: Id;
  name: string;
  groupId: Id;
  kind: CategoryKind;
  icon: CategoryIcon;
  color: ColorSlot;
  /** Still counted in reports, but has no budget line. */
  excludeFromBudget: boolean;
  archived: boolean;
  order: number;
}

export interface Tag {
  id: Id;
  name: string;
  color: ColorSlot;
}
