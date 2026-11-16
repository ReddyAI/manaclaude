import { mkdir, rm, lstat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RecoveryError } from './data.ts';

export async function github(path: string, binary = false) {
  const response = await fetch(
    'https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY + path,
    {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      },
      // fetch strips Authorization on a cross-origin signed asset redirect.
      redirect: binary ? 'follow' : 'error',
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok) throw new RecoveryError('Encrypted backup source could not be downloaded.');
  return response;
}
export async function download(action: string) {
  process.umask(0o077);
  if (!process.env.RUNNER_TEMP) throw new RecoveryError('Runner storage is required.');
  const directory = join(process.env.RUNNER_TEMP, 'recovery-input');
  if (action === 'cleanup') {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new RecoveryError('Use main.');
  const run = process.env.BACKUP_RUN_ID ?? '',
    tag = process.env.UPLOADED_RELEASE_TAG ?? '';
  if (Boolean(run) === Boolean(tag))
    throw new RecoveryError('Choose exactly one encrypted backup source.');
  if (run) {
    if (!/^\d+$/.test(run)) throw new RecoveryError('Invalid backup run number.');
    const data = (await (await github(`/actions/runs/${run}`)).json()) as {
      path: string;
      head_branch: string;
      event: string;
      status: string;
      conclusion: string;
    };
    if (
      !['.github/workflows/backup-production.yml', '.github/workflows/deploy-worker.yml'].includes(
        data.path,
      ) ||
      data.head_branch !== 'main' ||
      data.event !== 'workflow_dispatch' ||
      data.status !== 'completed'
    )
      throw new RecoveryError('Choose a completed official main backup/release run.');
    // Failed rollout checks can still leave a fully encrypted, verified backup.
    return;
  }
  if (tag.length > 200 || !/^[a-zA-Z0-9._/-]+$/.test(tag))
    throw new RecoveryError('Invalid upload tag.');
  if (action === 'validate') return;
  if (action !== 'uploaded') throw new RecoveryError('Unknown download operation.');
  type Release = {
    tag_name: string;
    draft: boolean;
    assets: { id: number; name: string; size: number }[];
  };
  let release: Release | undefined;
  for (let page = 1; page <= 20 && !release; page++) {
    const releases = (await (
      await github(`/releases?per_page=100&page=${page}`)
    ).json()) as Release[];
    release = releases.find((r) => r.tag_name === tag && r.draft);
    if (releases.length < 100) break;
  }
  const asset = release?.assets.find((a) => a.name === 'backup.enc');
  if (!asset || asset.size < 56 || asset.size > 8 * 1024 ** 3 + 32 * 1024 ** 2)
    throw new RecoveryError('Draft must contain one supported backup.enc asset.');
  await mkdir(directory, { mode: 0o700 });
  const response = await github(`/releases/assets/${asset.id}`, true);
  if (!response.body) throw new RecoveryError('Empty encrypted backup response.');
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(join(directory, 'backup.enc'), { flags: 'wx', mode: 0o600 }),
  );
  if ((await lstat(join(directory, 'backup.enc'))).size !== asset.size)
    throw new RecoveryError('Encrypted upload size mismatch.');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  download(process.argv[2] ?? '').catch(() => {
    console.error(
      '::error::Encrypted input validation/download failed. No production access was attempted.',
    );
    process.exitCode = 1;
  });
}
