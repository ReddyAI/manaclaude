# Browser tests

Playwright tests for the exported web build, run against a local Worker. They live here, not in `npm run check`; GitHub runs them as the separate "Browser tests" check on pull requests (`.github/workflows/e2e.yml`).

## Run them

```bash
export PATH=/opt/node24/bin:$PATH        # in the cloud container
npm run e2e -w @manaclaude/mobile
```

Playwright needs Chromium once: `npx playwright install chromium` (the cloud container already has it). One run takes a few minutes, most of it the web export.

Options, all environment variables:

- `E2E_WEB_DIR=<folder>`: use a web export you already made (`npx expo export --platform web --output-dir <folder>`) instead of exporting again.
- `E2E_PORT_BASE=8790`: the static server uses this port, the 412 px Worker the next one and the 1280 px Worker the one after.
- `E2E_OUT_DIR=<folder>`: where failure screenshots (and on CI the HTML report) go. Defaults to a folder in the system's temporary directory, never the repo.
- `E2E_KEEP_RUN_DIR=1`: keep the run folder (Worker logs, databases) instead of deleting it.

## What one run does

`harness/globalSetup.ts`:

1. Makes a temporary folder outside the repo.
2. Exports the web build into it (unless `E2E_WEB_DIR` is set) and serves it.
3. Writes a throwaway `.dev.vars` there with invented values and `ALLOW_SAMPLE_SEED=true`. No provider key is set.
4. For each screen width: applies every migration to a fresh database, starts `wrangler dev --local`, calls `POST /v1/dev/seed`, then plants what the tests look for (`harness/plant.ts` through the Worker's routes, `fixtures/plant.sql` for rows no route can make).
5. Stops the Workers and deletes the folder when the run ends. (`wrangler dev` itself leaves bundling temp files in `backend/.wrangler/tmp`, which git ignores.)

Each test opens the app with the Worker's address and token in the browser's `localStorage` (`billionaire.backendUrl`, `billionaire.apiToken`), waits for `GET /v1/dataset`, and fails on any page error or console error. Results are read back from the Worker's own API.

## What is planted

The local Worker's sample rates cover USD, INR and EUR only, so CHF has no rate:

- a CHF cash wallet "Zurich wallet" with a CHF expense "Migros" today, and a CHF budget on "Fees" this month;
- VTI held, bought and priced in CHF, and the "Xfinity internet" bill in CHF;
- two unlinked halves of a transfer between Everyday Checking and High-Yield Savings;
- an INR cash expense "E2E old chai stall" from 220 days ago, older than the oldest sample INR rate (150 days).

## Files

- `screens.spec.ts`: every main screen loads.
- `missing-rates.spec.ts`: the lines from blocks L, M, O and R that name what a total leaves out.
- `actions.spec.ts`: adding an account by hand, Look for transfers now, Run AI jobs now, the File layouts tab.
- `rates.spec.ts`: Settings, Exchange rates gives each currency's range of day rates, says when the oldest INR transaction is older than the oldest INR rate, and names CHF as having no rate (block V).
- `planning.spec.ts`: Planning's range of outcomes gives the same answer after a reload, says it is an estimate, and updates within 2 seconds with Chromium's CPU slowed four times (block W).
- `layout.spec.ts`: in all three looks, light and dark, five screens have no text below WCAG AA contrast, nothing cut off or overlapping, no sideways scrolling and no control without a name (block U).
- `audit.spec.ts`: the full screen-by-screen check of block U, every screen and sheet in every look and scheme. It only runs with `E2E_AUDIT=1` (`E2E_AUDIT=1 npm run e2e -w @manaclaude/mobile -- audit`), takes about 25 minutes, never fails on a finding, and writes screenshots and `audit.json` per look under `E2E_OUT_DIR/audit/`. `harness/audit.ts` holds the checks both use.
