# Production backup: GitHub buttons only

These workflows are prepared and tested locally. Codex has **not** run them against
production. After this PR is reviewed and merged, use the steps below. No terminal,
local CLI tools, API keys on your computer, or encrypted disk setup is needed.

## One-time setup in the GitHub website

1. Open **ReddyAI/manaclaude → Settings → Secrets and variables → Actions → New
   repository secret**. Name it **BACKUP_PASSPHRASE**. Paste a strong password from
   your password manager (at least 20 characters; a long generated password is
   best). Save the same password in your password manager. Losing it makes the
   backup unreadable. Do not send it in chat. The two existing Cloudflare Actions
   secrets are reused; no R2 S3 keys or local app token are needed.
2. Open **Settings → Environments → New environment** and name it
   **production-migrations**. Under deployment protection rules enable **Required
   reviewers**, add **ReddyAI (Sankar)**, and save. Allow Sankar to review a run he
   started (leave “Prevent self-review” unchecked). The release checks both the
   protection rule and the recorded approval; an automatically created, unprotected
   environment cannot release anything.
3. Open **Actions → Deploy to Cloudflare → Run workflow**, select **main**, tick
   **install_maintenance**, and press the green button. Open the run, choose
   **Review deployments**, approve **production-migrations**, and press **Approve
   and deploy**. This one-time run installs only the missing maintenance gate,
   closed to writes, and finishes with maintenance on. It refuses pending D1
   migrations and does not apply any. Leave this first-install checkbox off for
   all future releases. Continue with **Take a backup** below; that next run waits
   for the initial quarantine, makes the backup and resumes writes on success.

The first release adds the switch that older Workers did not have. Its initial
quarantine covers Cloudflare's documented 20-minute runtime-update retirement grace
and 15-minute cron limit; it does not retroactively instrument old invocations or
prove the earlier #35/#36/#38 windows were harmless. All later instrumented writers
are tracked durably and **never expire out of the drain count**. A stuck writer
blocks the operation and needs investigation; there is no force-drain button.

## Take a backup

1. Open **Actions → Back up production (encrypted) → Run workflow**. Keep **main**
   selected and press the green button. Do not deploy another release or edit the
   production database/bucket in Cloudflare while it runs.
2. Wait for success. The run closes writer admission before installing tools,
   waits for in-flight work, exports all D1, captures **every R2 object** including
   objects without a database row, verifies the capture, restores it into a
   disposable local database/bucket, compares data and metadata, deletes the
   disposable copy, and encrypts the complete backup. It checks the R2 inventory
   before/after, exact migration triggers, both revision singletons and deployed
   main provenance. The operator output includes counts, byte sizes, SHA-256
   checksums, and:
   - `Backup verified; restore drill passed; whole R2 inventory matched.`
   - `3a passed`, `3b passed`, `3d passed`.
   - One explanation that retained logs can identify historical write impact only
     if their version/write/row-ID coverage is complete. A new tail or absent,
     sampled or expired logs cannot rule out affected rows. This does not block a
     backup or claim that historical check 3c passed.
   - `Maintenance off`, after the encrypted upload and all checks succeed.
3. On the run's **Summary**, find **Artifacts → billionaire-backup-encrypted** and
   download it **within seven days**. GitHub gives you a ZIP: open it and keep the
   single **backup.enc** file on storage you control. Keep its password in your
   password manager. The runner prints `encryptedBytes` and `encryptedSha256` for
   that file. Only ciphertext is uploaded; SQL, manifests, originals, original
   filenames, keys and diagnostic logs stay private on the temporary runner and
   are deleted. GitHub's normal artifact/download messages use only generic names.

The baseline rollout check expects no saved history policy (effective version 0),
no bank reviews and no investment archive rows. A nonzero count fails for provenance
review; it does not prove corruption and the workflow never deletes or repairs it.
The already encrypted backup remains downloadable even if a later rollout check
fails. Sizes beyond the supported 64 MiB SQL, 20 MiB per R2 object, or portable 2 GiB
archive limit fail without silently omitting anything.

## Run the independent restore drill

For a recent backup, open its run and copy the number at the end of its URL
(`/actions/runs/NUMBER`). Open **Actions → Restore encrypted backup locally → Run
workflow**, select **main**, paste that number in **backup_run_id**, leave the
upload field blank, and press the green button. It downloads only the encrypted
artifact, decrypts it using BACKUP_PASSPHRASE, verifies it, restores all D1 and R2
into disposable local storage, and deletes the copy. Success prints counts and
checksums followed by **`Restore drill passed; disposable copy deleted.`** This
workflow has no Cloudflare credentials and no production restore command.

To test the **file you kept**, including after seven days:

1. Open **Code → Releases → Draft a new release**. Choose a new tag such as
   `private-backup-drill-2026-11-16` and attach **backup.enc** in the file upload
   area. Choose **Save draft**, not Publish. Do not attach any plaintext file.
2. Run **Restore encrypted backup locally** on **main**. Leave **backup_run_id**
   blank and enter that draft's tag in **uploaded_release_tag**. Success is the
   same restore message above. The workflow accepts only the fixed encrypted
   filename from an unpublished draft in this repository, never an arbitrary URL.
3. Delete the draft after the drill. Keep your own backup.enc and password. GitHub
   Actions does not offer a direct file-upload field on its Run workflow form;
   this draft attachment is the website-only upload path.

Use recovery code with the matching known migration history. New whole-bucket
bundles use recovery format v2, so older reference-only tooling rejects them rather
than silently dropping extra objects. Pre-migration bundles record their applied
migration prefix for later local verification with newer matching tooling.

## If a run fails

After pause has succeeded, any later failure/cancellation leaves maintenance on;
there is no unconditional cleanup step that resumes writers. If the runner could
not start or could not contact the switch, its state is **unconfirmed**, not off.
The error names the failed phase without printing private exception contents.

Open **Actions → Maintenance → Run workflow → mode: status**. A successful pause
and drain prints **maintenance: 1, activeWriters: 0, drained: 1**. Reads and
original-file downloads still work; writes return **503 maintenance**, and all four
cron triggers exit without provider calls or jobs. **mode: on** pauses and waits
for drain. **mode: off** resumes only when the coordinator confirms drain; never
use it to bypass a failed migration or unexplained data check. On success it prints
**maintenance: 0**. A stale ledger entry needs a separately reviewed investigation,
not an automatic timeout/reset. No financial repair runs automatically.

Only send counts and checksums back to Codex. Do not send backup contents, original
names, object keys, logs, revision tokens, passwords or API tokens. Production
restoration/cutover is outside this local drill.

## Future migrations

Merging main no longer starts the Worker migration/deploy workflow. A release is
manual and pinned to main. Before asking for Sankar's protected migration approval,
it must pause and confirm drain, capture/verify/restore a complete encrypted backup
of the currently applied migration prefix, and upload it. The next job then waits
for Sankar's approval and rechecks that backup proof in the same maintenance
generation immediately before **Apply D1 migrations**. The hold
survives Worker deployment; cron schedules may remain configured because their
handlers refuse admission. The workflow verifies the newly deployed main version,
migration journal, exact triggers and valid revisions before resuming. A failure
retains the hold; no old-Worker-only rollback or schema repair is attempted.
Before resume the coordinator activates the verified main release. Older
instrumented Workers remain unable to write even if traffic propagation briefly
sends them a request after the pause ends.

## Appendix: manual CLI path

The following is the earlier operator-only path for an owner who deliberately
chooses local CLI tools and encrypted storage. It predates the button workflows.
For **whole-bucket** coverage, use the new workflow; the old CLI path must stop if
its reference-only inventory differs from the bucket. A real capture still needs
a confirmed maintenance hold. No commands below have been run against production
by Codex.

### Original CLI instructions

Prepared 2026-11-16 for Sankar's own computer. **These commands have not been run
against production.** Stop on any failed command/check; do not repair, migrate,
deploy, rerun the deploy workflow, or change credentials as part of this runbook.

## Preconditions

- Use Bash, Node 24.10+ (24.22.1 preferred), npm 11, AWS CLI v2, GitHub CLI, and
  installed repository dependencies. Work from the repository root at
  `fdf8ad88a3be5390402a1e4b8457fb9c359955d7`; `git rev-parse HEAD` must print that
  SHA. A later schema needs matching recovery tooling and a reviewed runbook.
- Mount **Sankar-owned durable encrypted storage** outside every checkout. The
  example mount below must already be an unlocked encrypted volume, verified in
  the OS disk/encryption utility. `umask` and the recovery CLI do not encrypt.
  Put temporary files and diagnostic logs on that volume too. Do not use this
  cloud workspace, GitHub artifacts, or an unencrypted temporary directory.
- Load `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APP_API_TOKEN` and read-only
  R2 S3 credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) through your
  password manager or private terminal. Never paste them in chat or command
  arguments. Keep the **existing original** `CREDENTIALS_SECRET` separately in
  your secret manager; these commands do not need its value or change its use.
- Copy the **existing production D1 database UUID** from the Cloudflare dashboard;
  the Worker origin must use that database and `manaclaude-files` bucket. The
  commands below write a minimal private config for read-only commands, without
  creating Cloudflare resources. Do not run `deploy/prepare.ts`: it can create
  resources. Do not use the placeholder IDs in `backend/wrangler.toml`.
- **Before exporting, enforce and verify a stopped/drained-writer window.** Pause
  all four cron schedules (`*/5 * * * *`, `0 * * * *`, `30 6 * * *`,
  `2-57/5 * * * *`); block app/MCP mutations, callbacks and other write entry
  points; drain invocations, provider syncs, imports and `waitUntil` tasks. Keep
  the authenticated original-file GET routes readable. Record this privately.
  Closing your app or merely removing cron schedules is insufficient. The current
  repo has **no general maintenance gate**: if you cannot enforce this using
  existing operator controls, **stop here** and request a specific maintenance
  gate change. Do not pass `--writers-stopped` on an assumption. Keep the window
  through capture, drill and the live comparisons below; observe cron propagation
  and in-flight completion rather than assuming an immediate stop.

## 1. Capture, then prove complete original-file coverage

Set the non-secret selectors locally. Replace the example mount, D1 UUID and Worker
origin with your existing ones. Run each block in order.

```bash
set -euo pipefail
umask 077
export RECOVERY_PRIVATE_ROOT="/Volumes/BillionaireRecovery/production-$(date -u +%Y%m%dT%H%M%SZ)"
export RECOVERY_DATABASE_ID="COPY-EXISTING-PRODUCTION-D1-UUID"
export RECOVERY_API_ORIGIN="https://manaclaude-api.YOUR-SUBDOMAIN.workers.dev"
mkdir -m 700 "$RECOVERY_PRIVATE_ROOT"
mkdir -m 700 "$RECOVERY_PRIVATE_ROOT/tmp" "$RECOVERY_PRIVATE_ROOT/config" "$RECOVERY_PRIVATE_ROOT/wrangler-logs"
export TMPDIR="$RECOVERY_PRIVATE_ROOT/tmp/"
export XDG_CONFIG_HOME="$RECOVERY_PRIVATE_ROOT/config"
export WRANGLER_LOG_PATH="$RECOVERY_PRIVATE_ROOT/wrangler-logs/"
export WRANGLER_SEND_METRICS=false
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
: "${CLOUDFLARE_API_TOKEN:?Load privately first}"
: "${CLOUDFLARE_ACCOUNT_ID:?Load privately first}"
: "${APP_API_TOKEN:?Load privately first}"
: "${AWS_ACCESS_KEY_ID:?Load privately first}"
: "${AWS_SECRET_ACCESS_KEY:?Load privately first}"
export RECOVERY_WRANGLER_CONFIG="$RECOVERY_PRIVATE_ROOT/wrangler.production.json"
node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const id = process.env.RECOVERY_DATABASE_ID;
assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
writeFileSync(process.env.RECOVERY_WRANGLER_CONFIG, JSON.stringify({
  name: 'manaclaude-api', compatibility_date: '2026-10-15',
  d1_databases: [{ binding: 'DB', database_name: 'manaclaude', database_id: id }],
}), { flag: 'wx', mode: 0o600 });
NODE

./node_modules/.bin/wrangler d1 export manaclaude --remote \
  --config "$RECOVERY_WRANGLER_CONFIG" \
  --output "$RECOVERY_PRIVATE_ROOT/source.sql" \
  >"$RECOVERY_PRIVATE_ROOT/export.log" 2>&1
node backend/recovery/cli.ts backup \
  --sql "$RECOVERY_PRIVATE_ROOT/source.sql" \
  --api-url "$RECOVERY_API_ORIGIN" \
  --output "$RECOVERY_PRIVATE_ROOT/bundle" --writers-stopped \
  >"$RECOVERY_PRIVATE_ROOT/capture.json" 2>"$RECOVERY_PRIVATE_ROOT/capture.stderr"
RECOVERY_MANIFEST_SHA="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.env.RECOVERY_PRIVATE_ROOT+"/capture.json","utf8")).manifestSha256)')"
export RECOVERY_MANIFEST_SHA
aws s3api list-objects-v2 --bucket manaclaude-files \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --output json --no-cli-pager >"$RECOVERY_PRIVATE_ROOT/r2-inventory.json" \
  2>"$RECOVERY_PRIVATE_ROOT/r2-inventory.stderr"
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = process.env.RECOVERY_PRIVATE_ROOT;
const manifest = JSON.parse(readFileSync(root + '/bundle/manifest.json', 'utf8'));
const objects = JSON.parse(readFileSync(root + '/r2-inventory.json', 'utf8')).Contents ?? [];
const inventory = objects.map(o => [o.Key, o.Size]).sort(([a], [b]) => a.localeCompare(b));
const captured = manifest.files.map(o => [o.key, o.bytes]).sort(([a], [b]) => a.localeCompare(b));
assert.deepEqual(inventory, captured, 'R2 inventory differs: STOP; backup is incomplete');
console.log(JSON.stringify({ r2Objects: objects.length, capturedOriginals: manifest.files.length }));
NODE
```

Export succeeds with exit 0 and a nonempty `source.sql`; its log may contain a
signed download URL, so keep it private. Capture JSON contains only
`{"manifestSha256":"<64 lowercase hex>","tables":<count>,"files":<count>}`.
Save that digest separately in your trusted private record before continuing.
AWS CLI must paginate the **whole bucket** (no `--no-paginate` or `--max-items`).
The inventory check prints two equal counts on success, without object keys.

The existing CLI captures all **D1-referenced** statements and receipts, including
undone/discarded imports. It does not enumerate orphan R2 objects. If key/size sets
differ, **do not call this a complete backup or continue the drill**. Retain the
partial capture encrypted, report counts only, and seek approval for an all-object
capture/restore extension. Do not delete extra objects or omit missing originals.
SQL over 64 MiB, an original over 20 MiB, active committing imports, missing files,
or an incompatible schema also stop this procedure; do not alter data to pass it.

## 2. Verify, restore locally, compare, then delete the disposable target

```bash
node backend/recovery/cli.ts verify \
  --bundle "$RECOVERY_PRIVATE_ROOT/bundle" --manifest-sha256 "$RECOVERY_MANIFEST_SHA"
node backend/recovery/cli.ts restore-local \
  --bundle "$RECOVERY_PRIVATE_ROOT/bundle" --manifest-sha256 "$RECOVERY_MANIFEST_SHA" \
  --output "$RECOVERY_PRIVATE_ROOT/restore-drill"
node --input-type=module <<'NODE' >"$RECOVERY_PRIVATE_ROOT/counts-and-checksums.json"
import { readFileSync, statSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { verify } from './backend/recovery/cli.ts';
import { canonical, sha256 } from './backend/recovery/data.ts';
const root = process.env.RECOVERY_PRIVATE_ROOT;
const { image, manifest } = await verify(root + '/bundle', process.env.RECOVERY_MANIFEST_SHA);
const report = JSON.parse(readFileSync(root + '/restore-drill/verified.json', 'utf8'));
assert.equal(report.scope, 'local-restoration-only');
assert.equal(report.manifestSha256, process.env.RECOVERY_MANIFEST_SHA);
assert.equal(canonical(report.tables), canonical(manifest.tables));
const revisions = {};
for (const name of ['history_revision', 'investment_revision']) {
  const rows = image.tables.find(t => t.name === name)?.rows;
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].id, 1);
  assert.match(rows[0].revision, /^[a-f0-9]{64}$/);
  revisions[name + 'Sha256'] = sha256(rows[0].revision);
}
assert.equal(image.triggers.length, 24);
const bundleBytes = readdirSync(root + '/bundle').reduce((n, f) => n + statSync(root + '/bundle/' + f).size, 0);
console.log(JSON.stringify({ bundleBytes, manifestSha256: process.env.RECOVERY_MANIFEST_SHA,
  databaseBytes: manifest.database.bytes, databaseSha256: manifest.database.sha256,
  tables: manifest.tables, files: manifest.files.length,
  originalBytes: manifest.files.reduce((n, f) => n + f.bytes, 0),
  triggerCount: image.triggers.length, triggersSha256: sha256(canonical(image.triggers)),
  ...revisions }, null, 2));
NODE
```

Both CLI commands print `{"tables":<same count>,"files":<same count>}` and exit 0.
At this schema, expect 56 tables including `d1_migrations`, and 24 triggers (15
from 0011, nine from 0012); **file and row counts are production-dependent**.
`verify` requires the exact migration-owned trigger definitions, integrity and
valid revision values. `restore-local` installs triggers **after** records,
re-exports and compares every table's count/schema/value checksum, every index,
all trigger definitions, and every original's bytes/hash/MIME/application metadata.
Thus the restored singleton rows must equal the stopped production export, not
fresh generated values. No Worker app, scheduler, AI, provider or remote restore
is started. Inspect receipt readability privately before signing off.

After success (or to discard a failed partial drill), remove only the disposable
copy; preserve the encrypted bundle and separate trusted digest:

```bash
node --input-type=module <<'NODE'
import { rmSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const target = process.env.RECOVERY_PRIVATE_ROOT + '/restore-drill';
rmSync(target, { recursive: true, force: true });
assert.equal(existsSync(target), false);
console.log('Disposable restore deleted');
NODE
```

## 3. Read-only rollout checks, only after the complete backup/drill passes

Keep all query/log outputs on the encrypted volume. This command only selects
schema, revision state, migration metadata and counts:

```bash
./node_modules/.bin/wrangler d1 execute manaclaude --remote \
  --config "$RECOVERY_WRANGLER_CONFIG" --json \
  --command "SELECT name,applied_at FROM d1_migrations ORDER BY id; SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name; SELECT id,revision FROM history_revision; SELECT id,revision FROM investment_revision; SELECT COUNT(*) AS policy_rows,COALESCE(MAX(version),0) AS policy_version FROM history_policy; SELECT COUNT(*) AS bank_review_rows FROM history_bank_reviews; SELECT COUNT(*) AS archive_rows FROM investment_archive;" \
  >"$RECOVERY_PRIVATE_ROOT/rollout-d1.json" 2>"$RECOVERY_PRIVATE_ROOT/rollout-d1.stderr"
./node_modules/.bin/wrangler deployments list --name manaclaude-api \
  --config "$RECOVERY_WRANGLER_CONFIG" --json \
  >"$RECOVERY_PRIVATE_ROOT/deployments.json" 2>"$RECOVERY_PRIVATE_ROOT/deployments.stderr"
gh run list --repo ReddyAI/manaclaude --workflow deploy-worker.yml --event push \
  --commit fdf8ad88a3be5390402a1e4b8457fb9c359955d7 \
  --json databaseId,headSha,status,conclusion >"$RECOVERY_PRIVATE_ROOT/main-runs.json"
```

Each prints nothing to the terminal on success and exits 0. Inspect locally:

- **3a:** Migration names must match all 12 checked-out SQL filenames, including
  `0010_history_policy.sql`, `0011_history_revision.sql`, and
  `0012_investment_snapshots.sql`. Set `RECOVERY_RUN_ID` to the matching run's
  `databaseId` and `RECOVERY_VERSION_ID` to each active version from the deployment
  JSON, then run:

  ```bash
  gh run view "$RECOVERY_RUN_ID" --repo ReddyAI/manaclaude --log >"$RECOVERY_PRIVATE_ROOT/deploy-run.log"
  ./node_modules/.bin/wrangler versions view "$RECOVERY_VERSION_ID" \
    --name manaclaude-api --config "$RECOVERY_WRANGLER_CONFIG" --json \
    >"$RECOVERY_PRIVATE_ROOT/active-version.json" 2>"$RECOVERY_PRIVATE_ROOT/active-version.stderr"
  ```

  Require the active deployment's entire traffic allocation to be the version
  logged by the successful Worker deploy from the full SHA above. Follow any later
  secret-only versions to their code provenance. Missing provenance, an old version
  with traffic, or a green health check alone cannot pass this check.

- **3b:** Compare live trigger names/SQL with the verified export's 24 definitions
  (which `verify` matched exactly to local migrations). Require exactly one row,
  `id=1`, 64 lowercase hex, in each revision table; compare both live values with
  the captured values privately. Keep revision values out of the response.
- **3c:** In Cloudflare Workers & Pages → `manaclaude-api` → Observability/logs,
  inspect/export **retained historical** invocation and application logs around
  **2026-11-15 11:26 UTC**, **2026-11-15 12:10 UTC**, and
  **2026-11-16 17:42 UTC**. Use the three Actions job logs to derive actual migration
  start/end and Worker cutover times; widen for propagation and old in-flight tasks.
  Inspect HTTP/MCP transfer activations, import undo, scheduled nightly/FX jobs,
  link completions, manual/cron/continued syncs and background tasks. Correlate
  invocation version, write time and row IDs; retain candidate IDs privately.
  The pre-#36 Worker can commit a transfer then report a false conflict, and can
  overcount import undo because `meta.changes` includes 0011 trigger writes. 0010
  added no triggers. The pre-#38 Worker already includes #36's count fixes, but
  lacks #38's investment archive/fencing behavior. Do not equate those risks.
  **A new `wrangler tail` cannot recover past events.** Absent, sampled, expired,
  error-only or row-ID-free logs cannot prove absence of writes or identify deleted
  rows; record **failed to verify**, not “no affected rows.” Timestamps/current
  revision values are insufficient evidence. Do not trigger a sync or replay undo.
- **3d:** Expect `policy_rows=0`, effective `policy_version=0`, `bank_review_rows=0`
  and `archive_rows=0` for the requested untouched state. **No saved policy is an
  absent row**, not an inserted version-0 record. Archives can be legitimate after
  a new sync: if nonzero, stop and explain provenance by ID locally; do not assume
  corruption or delete anything. Any unexpected state needs Sankar's explicit yes
  to a specific repair before it is changed.

Record each check as passed or failed with the evidence's coverage limits. On a
failure, stop and describe the proposed repair or missing evidence; run no repair.
Ending the maintenance window is a separate operator decision after the checks.

## Send back only counts and checksums

Send the numeric counts/byte sizes and SHA-256 values in
`counts-and-checksums.json`, plus counts of failed checks, log windows with complete
evidence and potentially affected rows. Retain the check narratives privately for
follow-up; the return channel here is counts/checksums only. Do **not** send SQL,
bundles/manifests, originals, object keys, filenames, logs, revision values, tokens
or credentials. Keep the backup location privately recorded on your own encrypted
storage. No backup is complete until the inventory equality and real restore drill
both pass.
