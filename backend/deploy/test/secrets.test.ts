import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { planSecrets, pushSecrets } from '../secrets.ts';
import { WORKER_SECRET_NAMES } from '../names.ts';

describe('copying GitHub secrets into Worker secrets', () => {
  it('copies every listed secret that is set, skips blank and unlisted ones', () => {
    const plan = planSecrets({
      APP_API_TOKEN: 'a',
      MCP_OWNER_PASSWORD: 'b',
      CREDENTIALS_SECRET: 'c',
      PLAID_ENV: 'sandbox',
      KITE_API_KEY: '',
      SOMETHING_ELSE: 'no',
    });
    expect(plan.names.sort()).toEqual([
      'APP_API_TOKEN',
      'CREDENTIALS_SECRET',
      'MCP_OWNER_PASSWORD',
      'PLAID_ENV',
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('warns about the three secrets the app needs when they are missing', () => {
    const plan = planSecrets({ OXR_APP_ID: 'x' });
    expect(plan.warnings).toHaveLength(3);
    expect(plan.warnings.join(' ')).toMatch(
      /APP_API_TOKEN.*MCP_OWNER_PASSWORD.*CREDENTIALS_SECRET/s,
    );
  });

  it('passes the values through a private temp file, never the command line, and deletes it', () => {
    const env = Object.fromEntries(WORKER_SECRET_NAMES.map((n) => [n, `value-of-${n}`]));
    let seenFile = '';
    let seenContent = '';
    let seenMode = 0;
    const run = vi.fn((args: string[]) => {
      seenFile = args[2] ?? '';
      seenContent = readFileSync(seenFile, 'utf8');
      seenMode = statSync(seenFile).mode & 0o777;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    pushSecrets(env, { cwd: '/x', config: 'wrangler.deploy.toml', run });
    log.mockRestore();
    expect(run).toHaveBeenCalledTimes(1);
    const [args, cwd] = run.mock.calls[0] as unknown as [string[], string];
    expect(args.slice(0, 2)).toEqual(['secret', 'bulk']);
    expect(args.slice(3)).toEqual(['--name', 'manaclaude-api', '--config', 'wrangler.deploy.toml']);
    expect(cwd).toBe('/x');
    expect(args.join(' ')).not.toContain('value-of-');
    expect(JSON.parse(seenContent)).toEqual(env);
    expect(seenMode).toBe(0o600);
    expect(existsSync(seenFile)).toBe(false);
  });

  it('deletes the temp file even when wrangler fails, and does nothing when no secret is set', () => {
    let file = '';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() =>
      pushSecrets(
        { APP_API_TOKEN: 'a' },
        {
          cwd: '/x',
          config: 'c',
          run: (args) => {
            file = args[2] ?? '';
            throw new Error('wrangler failed');
          },
        },
      ),
    ).toThrow('wrangler failed');
    expect(existsSync(file)).toBe(false);
    const run = vi.fn();
    pushSecrets({}, { cwd: '/x', config: 'c', run });
    log.mockRestore();
    expect(run).not.toHaveBeenCalled();
  });
});
