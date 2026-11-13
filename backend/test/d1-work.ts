/** Local D1 row-work measurements, including each statement inside a batch. */
export function measureRows(inner: D1Database) {
  let read = 0;
  let written = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const count = <T>(result: D1Result<T>) => {
    read += result.meta.rows_read ?? 0;
    written += result.meta.rows_written ?? 0;
    return result;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === 'all') return async () => count(await target.all());
        if (prop === 'run') return async () => count(await target.run());
        if (prop === 'first')
          return async (column?: string) => {
            const result = count(await target.all<Record<string, unknown>>());
            const row = result.results[0];
            return row ? (column ? row[column] : row) : null;
          };
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const db = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) =>
          (await target.batch(statements.map((s) => originals.get(s) ?? s))).map(count);
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, read: () => read, written: () => written };
}
