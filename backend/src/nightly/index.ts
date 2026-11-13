import {
  addDays,
  addMonthsToMonth,
  firstDayOfMonth,
  monthOf,
  normalizeDescription,
  type Transaction,
} from '@manaclaude/shared';
import type { Env } from '../env';
import type { AiDeps } from '../ai/provider';
import { merchantsTable, recurringTable } from '../db/tables';
import { meterDb } from '../db/meter';
import { getSettings } from '../services/settings';
import { cleanPage, categorizePage, recurringNameKey, type CategorizeCursor } from './transactions';
import { alertStep, indexPage, recurringStep, type AlertCursor } from './analysis';
import { recapStep, startRecap, type RecapCursor } from './recap';
import { lastCompletePeriod } from '../ai/jobs/recap';
import { scheduledAi } from './ai';
import { guard, LEASE_MS, nameWrites, page, SCAN_PAGE } from './store';

export const NIGHTLY_CRON = '2-57/5 * * * *';
const PHASES = [
  'clear_names',
  'merchant_names',
  'recurring_names',
  'merchants',
  'categorize',
  'index',
  'recurring',
  'alerts',
  'recap_week',
  'recap_month',
  'clear_rows',
  'clear_groups',
  'done',
] as const;
type Phase = (typeof PHASES)[number];
export interface NightlyState {
  day: string;
  phase: Phase;
  after: string;
  alert: AlertCursor | null;
  categorize: CategorizeCursor | null;
  recap: RecapCursor | null;
  weeklyEnd?: string;
  monthlyEnd?: string;
}

/** A separate five-minute event: never shares a Free-plan allowance with sync/FX. */
export async function runNightlyStep(
  env: Env,
  scheduled: Date,
  deps: AiDeps & { now?: () => Date } = {},
) {
  const meter = meterDb(env.DB);
  env = { ...env, DB: meter.db };
  const db = env.DB;
  const now = deps.now ?? (() => new Date());
  const token = crypto.randomUUID();
  const time = now().getTime();
  const day = new Date(scheduled.getTime() - 6.5 * 3600_000).toISOString().slice(0, 10);
  const initial: NightlyState = {
    day,
    phase: 'clear_names',
    after: '',
    alert: null,
    categorize: null,
    recap: null,
  };
  const lease = await db
    .prepare(
      `INSERT INTO nightly_state (id, state, lease_token, lease_until) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET lease_token = excluded.lease_token, lease_until = excluded.lease_until
    WHERE nightly_state.lease_until <= ? RETURNING state`,
    )
    .bind(JSON.stringify(initial), token, time + LEASE_MS, time)
    .first<{ state: string }>();
  if (!lease) return;
  let state = JSON.parse(lease.state) as NightlyState;
  const writes: D1PreparedStatement[] = [];
  let transactions: Transaction[] = [];
  const next = () => {
    state.phase = PHASES[PHASES.indexOf(state.phase) + 1] ?? 'done';
    state.after = '';
  };
  try {
    if (state.phase === 'done' && state.day < day)
      state = { ...initial, weeklyEnd: state.weeklyEnd, monthlyEnd: state.monthlyEnd };
    if (
      state.phase === 'merchants' ||
      state.phase === 'categorize' ||
      state.recap?.phase === 'finish'
    ) {
      deps = { ...deps, ...(await scheduledAi(env, deps)) };
    }
    switch (state.phase) {
      case 'merchant_names': {
        const rows = await page(db, merchantsTable, state.after, SCAN_PAGE);
        writes.push(
          ...nameWrites(
            db,
            'merchant',
            rows.map((m) => ({ id: m.id, key: normalizeDescription(m.name) })),
          ),
        );
        const last = rows.at(-1);
        if (last) state.after = last.id;
        else next();
        break;
      }
      case 'recurring_names': {
        const rows = await page(db, recurringTable, state.after, SCAN_PAGE);
        writes.push(
          ...nameWrites(
            db,
            'recurring',
            rows.map((r) => ({
              id: r.id,
              key: recurringNameKey(r.accountId ?? '', r.name, r.expectedAmount),
            })),
          ),
        );
        const last = rows.at(-1);
        if (last) state.after = last.id;
        else next();
        break;
      }
      case 'categorize': {
        const result = await categorizePage(env, state.after, deps, state.categorize);
        transactions = result.transactions;
        writes.push(...result.writes);
        state.categorize = result.cursor;
        if (!state.categorize) {
          const last = transactions.at(-1);
          if (last) state.after = last.id;
          else next();
        }
        break;
      }
      case 'merchants':
      case 'index': {
        const result =
          state.phase === 'merchants'
            ? await cleanPage(env, state.after, deps)
            : await indexPage(env, state.after, state.day);
        transactions = result.transactions;
        writes.push(...result.writes);
        const last = transactions.at(-1);
        if (last) state.after = last.id;
        else next();
        break;
      }
      case 'recurring': {
        const result = await recurringStep(env, state.after, state.day);
        transactions = result.transactions;
        writes.push(...result.writes);
        if (result.key) state.after = result.key;
        else next();
        break;
      }
      case 'alerts': {
        const result = await alertStep(env, state.after, state.alert, state.day);
        writes.push(...result.writes);
        state.after = result.after;
        state.alert = result.cursor;
        if (result.done) next();
        break;
      }
      case 'recap_week':
      case 'recap_month': {
        const kind = state.phase === 'recap_week' ? 'weekly' : 'monthly';
        if (!state.recap) {
          const lastEnd = kind === 'weekly' ? state.weeklyEnd : state.monthlyEnd;
          const nextDay = lastEnd
            ? kind === 'weekly'
              ? addDays(lastEnd, 8)
              : firstDayOfMonth(addMonthsToMonth(monthOf(lastEnd), 2))
            : state.day;
          state.recap = startRecap(kind, [nextDay, state.day].sort()[0]!, await getSettings(db));
        }
        const result = await recapStep(env, state.recap, deps);
        writes.push(...result.writes);
        if (result.done) {
          const completed = state.recap.range.end;
          const latest = lastCompletePeriod(kind, state.day, state.recap.settings.weekStartsOn).end;
          if (kind === 'weekly') state.weeklyEnd = completed;
          else state.monthlyEnd = completed;
          state.recap = null;
          if (completed >= latest) next();
        }
        break;
      }
      case 'clear_names':
      case 'clear_rows':
      case 'clear_groups': {
        const table =
          state.phase === 'clear_names'
            ? 'nightly_names'
            : state.phase === 'clear_rows'
              ? 'nightly_rows'
              : 'nightly_groups';
        const key = table === 'nightly_names' ? 'rowid' : table === 'nightly_rows' ? 'id' : 'key';
        const rows = await db
          .prepare(`SELECT ${key} AS id FROM ${table} ORDER BY ${key} LIMIT ?`)
          .bind(SCAN_PAGE)
          .all<{ id: string }>();
        if (!rows.results.length) next();
        else
          writes.push(
            db
              .prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT value FROM json_each(?))`)
              .bind(JSON.stringify(rows.results.map((r) => r.id))),
          );
        break;
      }
      case 'done':
        break;
    }
    const commitTime = now().getTime();
    if (commitTime >= time + LEASE_MS) throw new Error('Nightly lease expired');
    // Reserve guard, checkpoint and failure cleanup; refuse the whole plan before
    // any financial write if a future code change exceeds the proven ceiling.
    if (meter.used() + writes.length + 3 > 38) throw new Error('Nightly query budget exceeded');
    await db.batch([
      guard(db, token, commitTime, transactions),
      ...writes,
      db
        .prepare(
          'UPDATE nightly_state SET state = ?, lease_token = NULL, lease_until = 0 WHERE id = 1 AND lease_token = ?',
        )
        .bind(JSON.stringify(state), token),
    ]);
  } catch (error) {
    await db
      .prepare(
        'UPDATE nightly_state SET lease_token = NULL, lease_until = 0 WHERE id = 1 AND lease_token = ?',
      )
      .bind(token)
      .run();
    throw error;
  }
}
