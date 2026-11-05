import type { Id, MinorUnits, Timestamps } from './common';
import type { TransactionKind } from './transaction';

export type RuleField = 'name' | 'rawName' | 'amount' | 'accountId' | 'categoryId' | 'currency';

export type RuleCondition =
  | {
      field: 'name' | 'rawName';
      op: 'contains' | 'equals' | 'starts_with' | 'regex';
      value: string;
      caseSensitive?: boolean;
    }
  | { field: 'amount'; op: 'equals' | 'gt' | 'lt'; value: MinorUnits }
  | { field: 'amount'; op: 'between'; value: [MinorUnits, MinorUnits] }
  | {
      field: 'accountId' | 'categoryId' | 'currency';
      op: 'equals' | 'in';
      value: string | string[];
    };

export type RuleAction =
  | { type: 'set_category'; categoryId: Id }
  | { type: 'set_name'; name: string }
  | { type: 'set_kind'; kind: TransactionKind }
  | { type: 'add_tag'; tagId: Id }
  | { type: 'mark_reviewed' }
  | { type: 'exclude' };

/**
 * A rule changes matching transactions when they arrive (sync or import).
 * Rules never change fields listed in Transaction.userEditedFields.
 */
export interface Rule extends Timestamps {
  id: Id;
  name: string;
  enabled: boolean;
  /** Lower runs first. */
  priority: number;
  match: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** "learned" rules come from the user's corrections of AI categories. */
  source: 'user' | 'learned';
}
