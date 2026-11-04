import type { Category, CategoryGroup, Tag } from '../model/category';

export const SAMPLE_CATEGORY_GROUPS: CategoryGroup[] = [
  { id: 'grp_income', name: 'Income', kind: 'income', order: 0 },
  { id: 'grp_housing', name: 'Housing', kind: 'expense', order: 1 },
  { id: 'grp_food', name: 'Food', kind: 'expense', order: 2 },
  { id: 'grp_transport', name: 'Transport', kind: 'expense', order: 3 },
  { id: 'grp_lifestyle', name: 'Lifestyle', kind: 'expense', order: 4 },
  { id: 'grp_health', name: 'Health', kind: 'expense', order: 5 },
  { id: 'grp_financial', name: 'Financial', kind: 'expense', order: 6 },
  { id: 'grp_transfers', name: 'Transfers', kind: 'transfer', order: 7 },
];

type CategorySeed = Omit<Category, 'excludeFromBudget' | 'archived' | 'order'> &
  Partial<Pick<Category, 'excludeFromBudget'>>;

const seeds: CategorySeed[] = [
  { id: 'cat_paycheck', name: 'Paycheck', groupId: 'grp_income', kind: 'income', icon: 'briefcase', color: 'c5' },
  { id: 'cat_interest', name: 'Interest', groupId: 'grp_income', kind: 'income', icon: 'percent', color: 'c6' },
  { id: 'cat_dividends', name: 'Dividends', groupId: 'grp_income', kind: 'income', icon: 'trending-up', color: 'c7' },
  { id: 'cat_rental_income', name: 'Rental income', groupId: 'grp_income', kind: 'income', icon: 'home', color: 'c8' },
  { id: 'cat_other_income', name: 'Other income', groupId: 'grp_income', kind: 'income', icon: 'banknote', color: 'c9' },

  { id: 'cat_rent', name: 'Rent', groupId: 'grp_housing', kind: 'expense', icon: 'home', color: 'c1' },
  { id: 'cat_utilities', name: 'Utilities', groupId: 'grp_housing', kind: 'expense', icon: 'zap', color: 'c2' },
  { id: 'cat_internet', name: 'Internet & phone', groupId: 'grp_housing', kind: 'expense', icon: 'wifi', color: 'c3' },
  { id: 'cat_household', name: 'Household', groupId: 'grp_housing', kind: 'expense', icon: 'wrench', color: 'c4' },

  { id: 'cat_groceries', name: 'Groceries', groupId: 'grp_food', kind: 'expense', icon: 'shopping-cart', color: 'c5' },
  { id: 'cat_dining', name: 'Restaurants', groupId: 'grp_food', kind: 'expense', icon: 'utensils', color: 'c6' },
  { id: 'cat_coffee', name: 'Coffee', groupId: 'grp_food', kind: 'expense', icon: 'coffee', color: 'c7' },

  { id: 'cat_gas', name: 'Gas', groupId: 'grp_transport', kind: 'expense', icon: 'fuel', color: 'c8' },
  { id: 'cat_rideshare', name: 'Rideshare & transit', groupId: 'grp_transport', kind: 'expense', icon: 'bus', color: 'c9' },
  { id: 'cat_car', name: 'Car insurance & care', groupId: 'grp_transport', kind: 'expense', icon: 'car', color: 'c10' },

  { id: 'cat_shopping', name: 'Shopping', groupId: 'grp_lifestyle', kind: 'expense', icon: 'shopping-bag', color: 'c11' },
  { id: 'cat_subscriptions', name: 'Subscriptions', groupId: 'grp_lifestyle', kind: 'expense', icon: 'repeat', color: 'c12' },
  { id: 'cat_entertainment', name: 'Entertainment', groupId: 'grp_lifestyle', kind: 'expense', icon: 'film', color: 'c1' },
  { id: 'cat_fitness', name: 'Fitness', groupId: 'grp_lifestyle', kind: 'expense', icon: 'dumbbell', color: 'c2' },
  { id: 'cat_travel', name: 'Travel', groupId: 'grp_lifestyle', kind: 'expense', icon: 'plane', color: 'c3' },
  { id: 'cat_gifts', name: 'Gifts & family', groupId: 'grp_lifestyle', kind: 'expense', icon: 'gift', color: 'c4' },

  { id: 'cat_health', name: 'Health & pharmacy', groupId: 'grp_health', kind: 'expense', icon: 'heart-pulse', color: 'c5' },

  { id: 'cat_loan_interest', name: 'Loan interest', groupId: 'grp_financial', kind: 'expense', icon: 'percent', color: 'c6' },
  { id: 'cat_fees', name: 'Fees', groupId: 'grp_financial', kind: 'expense', icon: 'receipt', color: 'c7' },

  { id: 'cat_transfer', name: 'Transfer', groupId: 'grp_transfers', kind: 'transfer', icon: 'repeat', color: 'c9', excludeFromBudget: true },
  { id: 'cat_card_payment', name: 'Credit card payment', groupId: 'grp_transfers', kind: 'transfer', icon: 'credit-card', color: 'c10', excludeFromBudget: true },
  { id: 'cat_investment_contribution', name: 'Investment contribution', groupId: 'grp_transfers', kind: 'transfer', icon: 'piggy-bank', color: 'c11', excludeFromBudget: true },
  { id: 'cat_loan_payment', name: 'Loan payment', groupId: 'grp_transfers', kind: 'transfer', icon: 'landmark', color: 'c12', excludeFromBudget: true },
];

export const SAMPLE_CATEGORIES: Category[] = seeds.map((s, i) => ({
  excludeFromBudget: false,
  archived: false,
  order: i,
  ...s,
}));

export const SAMPLE_TAGS: Tag[] = [
  { id: 'tag_india_trip', name: 'India trip', color: 'c3' },
  { id: 'tag_reimbursable', name: 'Reimbursable', color: 'c7' },
  { id: 'tag_tax', name: 'Tax', color: 'c9' },
];
