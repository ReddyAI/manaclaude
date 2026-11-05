import { DEFAULT_SETTINGS, type MoneyPolicies, type Settings } from '@manaclaude/shared';

const KEY = 'app';

/** Settings with defaults filled in, so new fields work on old databases. */
export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(KEY)
    .first<{ value: string }>();
  const stored = row ? (JSON.parse(row.value) as Partial<Settings>) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    moneyPolicies: { ...DEFAULT_SETTINGS.moneyPolicies, ...(stored.moneyPolicies ?? {}) },
  };
}

export type SettingsPatch = Partial<Omit<Settings, 'moneyPolicies'>> & {
  moneyPolicies?: Partial<MoneyPolicies>;
};

export async function updateSettings(db: D1Database, patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings(db);
  const next: Settings = {
    ...current,
    ...patch,
    moneyPolicies: { ...current.moneyPolicies, ...(patch.moneyPolicies ?? {}) },
  };
  await db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .bind(KEY, JSON.stringify(next))
    .run();
  return next;
}
