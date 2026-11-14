import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { seedAndPlant } from './plant';
import { serveStatic } from './staticServer';
import { E2E_TOKEN, startWorker, type LocalWorker } from './worker';

const APP_DIR = path.resolve(__dirname, '../..');

/** Exports the web build unless E2E_WEB_DIR points at one already made. */
function webBuild(runDir: string): string {
  const given = process.env.E2E_WEB_DIR;
  if (given) {
    if (!fs.existsSync(path.join(given, 'index.html'))) {
      throw new Error(`E2E_WEB_DIR=${given} has no index.html`);
    }
    return given;
  }
  const out = path.join(runDir, 'web');
  const r = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', out], {
    cwd: APP_DIR,
    env: { ...process.env, CI: '1', EXPO_OFFLINE: '1' },
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (r.status !== 0) throw new Error(`expo export failed:\n${r.stdout}\n${r.stderr}`);
  return out;
}

/**
 * One fresh run: a temporary folder (outside the repo) holding the web
 * export, the throwaway .dev.vars and one database per screen width. Returns
 * the teardown, which stops everything and deletes the folder.
 */
export default async function globalSetup(config: FullConfig) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billionaire-e2e-'));
  const workers: LocalWorker[] = [];
  let server: Awaited<ReturnType<typeof serveStatic>> | null = null;

  const teardown = async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (process.env.E2E_KEEP_RUN_DIR) {
      console.warn(`Kept the run folder: ${runDir}`);
    } else {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  };

  try {
    const web = webBuild(runDir);
    const webPort = Number(new URL(config.projects[0]?.use.baseURL ?? '').port);
    server = await serveStatic(web, webPort);

    const ports = [
      ...new Set(config.projects.map((p) => (p.use as { backendPort?: number }).backendPort ?? 0)),
    ].filter((p) => p > 0);
    for (const port of ports) {
      const worker = await startWorker(runDir, port);
      workers.push(worker);
      await seedAndPlant(runDir, worker);
    }
    process.env.E2E_TOKEN = E2E_TOKEN;
    process.env.E2E_RUN_DIR = runDir;
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
