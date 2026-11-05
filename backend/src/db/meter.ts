/**
 * Counts D1 queries in one Worker invocation.
 *
 * Cloudflare's Workers Free plan allows about 50 D1 queries per invocation.
 * The documentation could not be opened from the build environment, so this
 * counts conservatively: every statement inside db.batch() is one query, and
 * so is every run(), all(), first() and raw(). Sync code asks the meter how
 * much is left before it starts another step, and the tests wrap the database
 * the same way to prove a step never goes over.
 */

export const D1_QUERIES_PER_INVOCATION = 50;

export interface MeteredDb {
  db: D1Database;
  /** Queries made through `db` so far. */
  used(): number;
}

const WRAPPED = Symbol('mana.realStatement');

type Wrapped = D1PreparedStatement & { [WRAPPED]?: D1PreparedStatement };

export function meterDb(inner: D1Database, start = 0): MeteredDb {
  let count = start;
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy: Wrapped = new Proxy(stmt, {
      get(target, prop) {
        if (prop === WRAPPED) return target;
        if (prop === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          return (...args: unknown[]) => {
            count += 1;
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return proxy;
  };
  const db = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          count += statements.length;
          return target.batch(statements.map((s) => (s as Wrapped)[WRAPPED] ?? s));
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          count += sql.split(';').filter((s) => s.trim() !== '').length;
          return target.exec(sql);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, used: () => count };
}

/** How many queries a sync may still spend, given a meter and a ceiling. */
export class QueryBudget {
  constructor(
    private readonly meter: MeteredDb,
    readonly limit: number,
  ) {}

  get used(): number {
    return this.meter.used();
  }

  get left(): number {
    return Math.max(0, this.limit - this.meter.used());
  }

  allows(n: number): boolean {
    return this.left >= n;
  }
}
