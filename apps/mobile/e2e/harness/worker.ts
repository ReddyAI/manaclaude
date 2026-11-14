import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Invented values only. Nothing here is a real key, and no provider key is set. */
export const E2E_TOKEN = 'e2e-invented-app-token-0001';

const DEV_VARS = [
  `APP_API_TOKEN=${E2E_TOKEN}`,
  'CREDENTIALS_SECRET=e2e-invented-credentials-secret-0001',
  'MCP_OWNER_PASSWORD=e2e-invented-owner-password',
  'ALLOW_SAMPLE_SEED=true',
  '',
].join('\n');

export const BACKEND_DIR = path.resolve(__dirname, '../../../../backend');

/** Keeps wrangler from asking questions, sending metrics or writing logs into the repo. */
function wranglerEnv(runDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: '1',
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: path.join(runDir, 'wrangler-logs'),
    XDG_CONFIG_HOME: path.join(runDir, 'config'),
  };
}

function npx(args: string[], runDir: string): void {
  const r = spawnSync('npx', args, {
    cwd: BACKEND_DIR,
    env: wranglerEnv(runDir),
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (r.status !== 0) {
    throw new Error(`npx ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  }
}

/** The throwaway .dev.vars for this run, outside the repo. */
export function writeDevVars(runDir: string): string {
  const file = path.join(runDir, '.dev.vars');
  fs.writeFileSync(file, DEV_VARS);
  return file;
}

export interface LocalWorker {
  url: string;
  persistDir: string;
  process: ChildProcess;
  stop(): Promise<void>;
}

/** Applies every migration to a fresh database, then starts `wrangler dev --local`. */
export async function startWorker(runDir: string, port: number): Promise<LocalWorker> {
  const persistDir = path.join(runDir, `state-${port}`);
  fs.rmSync(persistDir, { recursive: true, force: true });
  const envFile = writeDevVars(runDir);
  npx(
    ['wrangler', 'd1', 'migrations', 'apply', 'manaclaude', '--local', '--persist-to', persistDir],
    runDir,
  );

  const log = fs.openSync(path.join(runDir, `wrangler-${port}.log`), 'w');
  const child = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(port + 100),
      '--persist-to',
      persistDir,
      '--env-file',
      envFile,
      '--show-interactive-dev-session=false',
    ],
    { cwd: BACKEND_DIR, env: wranglerEnv(runDir), stdio: ['ignore', log, log], detached: true },
  );
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      return;
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  };

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `wrangler dev exited early; see ${path.join(runDir, `wrangler-${port}.log`)}`,
      );
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`wrangler dev on port ${port} did not start in 90 s`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, persistDir, process: child, stop };
}

/** Runs SQL against a Worker's local database (for rows no route can make). */
export function executeSql(runDir: string, persistDir: string, sqlFile: string): void {
  npx(
    [
      'wrangler',
      'd1',
      'execute',
      'manaclaude',
      '--local',
      '--persist-to',
      persistDir,
      '--file',
      sqlFile,
      '--yes',
    ],
    runDir,
  );
}
