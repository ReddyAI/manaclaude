# Claude handoff log

Claude appends an entry here after each task. Codex's log is `codex-log.md`; Claude never edits it. No secrets, personal details or real account data in this file.

## 2026-11-12 — Phase 1: phone safety (settings, backend scoping, fixed test clock)

Started from `main` at `24d7195` (PR #13 merged; PRs #10 to #12 verified as merged) on `claude/focused-heisenberg-3xmrry`. Closes findings **6, 15 and 17** from the Codex review. Only `apps/mobile/` and this log changed. No shared, backend, connector, root-config, workflow, dependency or lockfile changes.

### What changed

Settings the backend keeps (finding 6):

- `apps/mobile/src/data/backend/settingsSync.ts` (new) replaces the old "send every server setting whenever anything changes" watcher that lived in `sync.ts`.
  - The backend's settings arrive with `GET /v1/dataset` and are put into the phone's settings store. Nothing is sent to a backend until its settings have arrived on this device in this session.
  - A change sends only the changed field: `{ "hapticsEnabled": false }`, or for money policies only the policy that changed: `{ "moneyPolicies": { "transfers": "count" } }`. The Worker's `PATCH /v1/settings` already merges partial bodies, so no backend change was needed.
  - A change that could not be sent (offline, error, made before the first load finished) waits and is sent after the next successful load. It is saved in AsyncStorage (`billionaire.pendingSettings`, tagged with the backend it is for) so it survives closing the app.
  - A dataset answer requested before a confirmed save is not allowed to put the old value back.
- `apps/mobile/src/data/settingsStore.ts`: `updateSettings` (a change made in the app) now notifies change listeners with before and after; new `applyBackendSettings` (the backend's copy arriving) does not. New `subscribeSettingChanges`. Existing exports are unchanged.

Requests and saved data tied to the selected backend (finding 15):

- `apps/mobile/src/data/backend/config.ts`: the config has a `scope`, a random id that is replaced whenever the URL or token changes or the token is forgotten. It is stored in AsyncStorage (`billionaire.backendScope`) and is not derived from the token. Saving the same URL and token again keeps the scope. Forget token now switches scope before the secure store finishes deleting.
- `apps/mobile/src/data/backend/client.ts`: every `api()` call made with the saved URL and token is aborted when the scope changes, and an answer that still arrives is thrown away as a `BackendError` with code `superseded` (`isSuperseded(e)`). Calls that name their own URL and token (the check in Settings before saving) are left alone.
- `apps/mobile/src/data/backend/sync.ts`: the in-flight dataset load is keyed by scope. On a scope change the app goes back to sample data at once, deletes the saved copy, cancels the delayed reload and drops waiting settings, then loads the new backend. `persist()` sends a change only when the data on screen was loaded from the backend selected now (new `canSaveToBackend()`), and neither undoes nor reports a save whose backend changed meanwhile. Before this, an edit made to the sample data while the first load was running could be sent to the backend.
- `apps/mobile/src/data/backend/datasetCache.ts` and `datasetCache.web.ts`: the saved copy records its scope and is read only for the same scope. A copy from before this change has no scope and is ignored once (one slower start).
- `apps/mobile/src/data/backend/status.ts` (new): the status store moved out of `sync.ts` so `settingsSync.ts` can report errors without an import cycle. `sync.ts` re-exports the same names, so no importer changed.
- `apps/mobile/src/features/settings/sections/BackendSection.tsx`: pressing Forget token while Save is still checking no longer lets that check save a token afterwards.

Fixed test clock (finding 17):

- `apps/mobile/jest.config.js`: `Date` is fixed at `2026-11-05T12:00:00.000Z` for every mobile test (the same moment the backend tests use). Only `Date` is replaced; timers and promises are real. No test assertion was weakened: the recap test still presses "October 2026".
- `apps/mobile/src/data/__tests__/clock.test.ts` (new) checks the clock, that it does not move during a test, and that sample data (including the data the store starts with) is dated from it.

Tests added (all invented data):

- `src/data/backend/__tests__/scoping.test.tsx`: late dataset answer after Forget; late answer from the old backend after switching; new backend unreachable shows sample data, not the old backend's; saved copy opens only for its own backend and old unscoped copies are ignored; scope rules; superseded answers in `api()`; no save while sample data is on screen; no undo or banner for a save whose backend was forgotten.
- `src/data/backend/__tests__/settingsSync.test.tsx`: a new phone adopts the backend's settings and sends nothing; one field per change; one money policy per change; phone-only settings never sent; nothing saved up in sample mode; change made during the first load; refused save kept and resent; waiting change survives a restart; waiting change dropped on Forget or backend change; stale dataset answer cannot undo a save.
- `src/data/backend/__tests__/datasetCache.web.test.ts`, one more case in `src/features/settings/__tests__/backendSection.test.tsx`, and `helpers.ts` / `mocks.ts` (a fake Worker with answers the test can hold back, in-memory secure store and file system).
- `src/data/backend/__tests__/backend.test.tsx`: the "undoes a refused change" test now loads the dataset first, because saving needs the backend's data on screen. Its assertions are unchanged.

### Defaults chosen

- Conflict rule: per field, the last deliberate change wins. A field you did not change on this device always takes the backend's value on the next load.
- All twelve backend-kept settings follow the backend, including look, light/dark, haptics, dashboard layout and display currency. So a second device takes on the first device's look. If those should be per device, they need to come out of the backend's list (a Codex change to the settings schema plus one line here).
- Flex budgeting, default rollover and planning assumptions stay on the phone only, as before (the Worker's settings schema does not accept them).
- A token change on the same URL counts as a new backend: sample data shows for a moment, then the data loads again.
- Changes made in sample mode are never sent later when a backend is added.
- Screens that call the API themselves (link, import) show "The backend settings changed while this was loading, so its answer was ignored. Try again." if the backend changes under them.
- The map of receipt photos on the phone (`billionaire.receiptUris`) is still not tied to a backend. It only maps a server receipt id to a local photo path.

### Validation

- `npm run check` passed: typecheck, lint, format and **835 tests** (shared 118, connectors 345, backend 174, deployment/runtime 35, mobile 163, up from 136).
- In this cloud container ESLint ran out of memory with Node's default heap, on untouched `main` as well as on this branch. The check was run with `NODE_OPTIONS=--max-old-space-size=8192`. No config was changed for this; GitHub's CI result is the reference.
- Each guard was removed in turn to confirm a test fails without it: stale-answer guard (3 failures), wait-for-load and waiting-change overlay (1), stale-dataset marker (1), cache scope (1).
- Browser check with the exported web build against a local Worker (`wrangler dev --local`, throwaway token, invented data): the backend was set to AI off, MCP write tools on, refunds as income. A fresh browser with default settings connected, sent zero `PATCH /v1/settings`, and showed the backend's three values. One haptics toggle sent exactly `{"hapticsEnabled":false}` and the other values on the Worker were unchanged. Forget token during a held-back reload left sample data on screen, no saved copy and no token in browser storage.
- Not tested on an Android device or emulator in this session (none available here). Phone steps are in the PR.

### Remaining work and dependencies

- Phase 2 (import review flow) waits on Codex's manual-account creation API (finding 7). Needed from that contract: route and body for creating a manual non-cash account (name, type, currency, optional mask), what it returns, and whether `POST /v1/imports` can create the destination as part of commit instead. The other Phase 2 fields are already documented in the Codex log's API table.
- Shared API types for the import fields (`fromDate`, `toDate`, `accountMappings`, `currency`, `sourceFormat`, `dateRange`, `duplicateCandidates`, `requiresDateConfirmation`, `keepLines`, `warnings`) are not added yet; that is the first Phase 2 step and is authorized as additive shared edits.
- Mobile parts of findings 10 (serialized Sophtron polling) and 11 (SnapTrade cancel is not a successful Repair) are Phase 3 and wait on Codex's completion contracts.

## 2026-11-12 — Phase 2: import review flow (Monefy history and statements), without new backend work

Started from `main` at `5009636` (PR #14 merged) on `claude/focused-heisenberg-3xmrry`. Sankar asked for Phase 2 to go ahead without waiting for Codex, and for a list of what Codex needs to do. This builds everything the merged backend (PR #12) already supports and prepares the one thing it does not (a new bank account for a file that names none). Changed: `apps/mobile/src/features/import/`, additive types in `packages/shared/src/api/index.ts` (authorized for this phase), and this log. No backend, connector, root-config, workflow or dependency changes.

### What changed

`packages/shared/src/api/index.ts` (additive only; backend typecheck and tests still pass):

- `ImportPreview` gains optional `sourceFormat`, `duplicateCandidates`, `dateRange`, `requiresDateConfirmation` (the same names and shapes the backend already returns through its own `SafeImportPreview`).
- `ImportCommitRequest.keepLines`, `ImportCommitResult.warnings`.
- New: `ImportDuplicateCandidate`, `ImportDateRange`, `ImportPreviewOptions` (the multipart fields), `ImportErrorCode`, `ImportListResponse`, `ImportDetail`, `ImportUndoResult`.
- `MANUAL_ACCOUNT_TYPES`, `ManualAccountType`, `ManualAccountRequest`, `ManualAccountResponse` for `POST /v1/accounts/manual`. First written as a proposal; replaced by the merged backend contract in the next entry.

`apps/mobile/src/features/import/`:

- `importApi.ts`: preview with all options, commit with `skipLines`/`keepLines`, `getImport`, `listImports`, `undoImport`, and `manualAccountsSupported()` / `createManualAccount()` for the proposed route.
- `importFlow.ts` (pure rules, no screen): what a preview is asked for, which rows a save adds or leaves out, the reasons a save is not allowed yet, totals per account and currency, and which keep/skip answers survive a new preview.
- `useImportFlow.ts`: the screen's state and actions (pick, preview, review, save, check an interrupted save, undo, make an account).
- `pendingImport.ts`: remembers the one import whose save started but whose outcome was not seen, tied to the backend it was sent to.
- Screen parts: `ImportScreen.tsx` (rebuilt, with Import and History tabs), `WhatToImportCard.tsx`, `DestinationCard.tsx`, `NewAccountForm.tsx`, `CsvColumnsCard.tsx`, `ReviewCards.tsx`, `PreviewCard.tsx`, `ImportHistory.tsx`, `labels.ts`.

What the screen now does:

- **Dates:** From and To fields, both days included, with chips for the last six months in the file. The preview says how many readable rows fall outside the dates.
- **Accounts:** a file that names its accounts (Monefy, QIF with accounts, OFX) gets one line per account: an existing account, a new one made from the file, or left out. Only accounts in the same currency are offered. A file with no account inside gets one destination.
- **Date order:** Monefy and QIF get Day first / Month first; bank CSVs get the candidate formats. When the file can be read two ways, Import stays off until one is chosen and a new preview is made.
- **Currency:** asked only when the file has none and no destination supplies it.
- **CSV layout:** lines above the header, header on or off, date column and date format, description column, one amount column (with a sign flip) or separate debit and credit columns.
- **Possible duplicates:** the file's row next to the stored transaction(s), with Keep both or Skip the file's row for each, plus keep-all and skip-all. Import stays off until every one is answered.
- **Unreadable lines:** listed with line numbers; the rest is saved only after a switch says to leave them out.
- **Totals to compare:** rows, money in and money out per destination and currency, before and after the save. These are the file's own amounts, not the app's spending policy.
- **Changed previews:** changing any choice marks the preview as old and turns Import off until it is updated. If transactions change during the review (HTTP 409 `import_preview_changed`, or new duplicates found at save time), the app makes a fresh preview and says so; only answers for unchanged pairs are kept.
- **Interrupted saves:** if the answer to a save is lost, the app asks the Worker (`GET /v1/imports/:id`) instead of saving again: saved (counts read back), still saving, or nothing saved. If the Worker cannot be asked, it says so and offers Check again, never a second import. This survives closing the app.
- **Save warnings:** shown with the result, with "the rows are saved; do not import this file again".
- **History and undo:** saved, undone and unreadable imports are listed; a saved one can be undone after a second press, from History or straight from the result.

### Defaults chosen

- A preview is made only when the button is pressed (each preview stores the file in the vault). The app discards the preview it replaces.
- "Leave out" for an account in the file needs no new preview; it is sent as `skipLines`.
- Accounts offered as destinations: every visible account except property, vehicle and crypto (so cash wallets are offered for Monefy).
- New account from a Monefy file keeps the backend's default: history only, balance zero, kept out of net worth.
- The "New account" form (name, type, currency, last four digits) appears only when the Worker answers the proposed route. The app asks once per backend with an empty body, which cannot create anything. Until then the screen says the Worker needs an update and offers existing accounts.
- A column layout saved from an earlier file of the same bank carries that file's count of skipped lines. The app re-reads the new file from its own first line (see problem 2 below).
- Per-row untick in the preview list is not built; rows can be left out by account, by duplicate answer, or as unreadable lines.

### Validation

- `npm run check` passed: typecheck, lint, format and **871 tests** (shared 118, connectors 345, backend 174, deployment/runtime 35, mobile 199, up from 163). As in Phase 1, ESLint needed `NODE_OPTIONS=--max-old-space-size=8192` in the cloud container. New mobile tests: `importFlow.test.ts` (15) and a rewritten `import.test.tsx` (24), all with invented data. Guards were removed in turn to confirm tests fail without them.
- Web, phone width (412 px) and desktop width (1280 px), exported build against a local Worker seeded with the invented sample data, real multipart uploads:
  - Monefy file with two accounts and ambiguous dates: confirmation required, one month selected (2 rows outside), one account mapped to an existing INR wallet and one made from the file, totals matched by hand (USD 3 rows in 125.50 out 28.50; INR 2 rows out 450.50), 5 saved, INR amounts unconverted, undo returned the transaction count to its start, import again added 5, a third run of the whole file showed 5 already there and 2 new.
  - Bank CSV with two lines above the header, debit and credit columns, day-first dates and one broken line: columns and date format set by hand, broken line listed and left out, 3 saved with correct signs and dates.
  - Second file of the same bank: saved layout reused without losing its first rows; a row with the same amount one day apart was shown as a possible duplicate and skipped.
  - QIF with no currency or account, OFX naming an unknown account (made with its last four digits), and a repeat OFX (nothing new).
  - Save answer lost and Worker unreachable: "Not sure this was saved"; after reopening, found saved and read back; one commit only.
  - Another import landing in the account during review: fresh preview with a note, new duplicate had to be answered, then saved.
- The Android JavaScript bundle builds (`expo export --platform android`). **Not run on an Android device or emulator** (none in the cloud session). PDF import was not exercised (it needs Workers AI on Cloudflare); its path through the screen is unchanged.

### What Codex needs to do (highest impact first)

1. **Manual account route.** Delivered by Codex in PR #16, with a different contract from the one first proposed here (a retry key and an explicit known-or-unknown balance; no mask, no name-based 409). The app now follows PR #16's contract; see the next entry.
2. **Saved CSV layouts skip the wrong lines.** `backend/src/imports/service.ts` `parseFile`: a mapping saved under a header signature is reused with its stored `skipRows`, although the signature was computed at the request's `skipRows`. A second statement from the same bank with no lines above its header loses its first two lines (one of them a transaction) with no warning. Reproduced on a local Worker. Fix: when reusing a saved mapping, set `skipRows` to the request's value. The app works around it by previewing again with the corrected mapping.
3. **One unreadable line hides the date format.** `packages/shared/src/import/csv.ts` `suggestCsvMapping` passes every date cell to `detectDateFormat`, which needs all of them to parse. A statement with one footer or broken line comes back as `needs_mapping` with `missing: ['date']`, and the person has to pick the format from fourteen choices. Fix: detect from the cells that parse (as the Monefy reader does) and report the others as line errors.
4. **Previews that are never saved pile up.** Every preview stores the file in R2 and a row in `imports`; discard only changes the status. Also a record stuck in `committing` (lease expired, no retry) can never be discarded. Suggested: delete the R2 object on discard, expire old previews, and allow discarding a stale `committing` record.
5. **Monefy coverage.** An account that holds two currencies is refused line by line, and transfer rows are refused. Both will matter for the real history. Needs verified examples, as already noted in the Codex log.
6. **Skipping a duplicate loses the file's notes and category.** A way to merge them into the kept transaction, on confirmation.
7. **Undo leaves accounts and categories the import made.** An operation to remove an import-made account that has no transactions left (also needed for Phase 5 account management).
8. **Contracts for Phase 3** before the mobile screens: per-account history dates, attaching a provider account to an existing one, replayable Sophtron completion, and SnapTrade Repair that fails on cancel.

Not Codex's, but outside what Claude may edit: `docs/setup.md` line 161 still describes the old three-step import.

### Remaining mobile work in this phase

- Android device run of the import journey (steps are in the PR).
- The real migration: one small month first, compare counts and totals per account and currency, undo, import again, then widen. Sankar runs this with his own file; nothing from it goes into the repo.
- Per-row untick in the preview, if wanted after the first real month.

## 2026-11-13 — PR #15 aligned with the manual-account contract from PR #16

Sankar merged Codex's PR #16 (`POST /v1/accounts/manual`) while PR #15 was open. Codex's log showed the account form in #15 sent a body the Worker refuses: no `idempotencyKey`, no `currentBalance`, a `mask` the route does not accept, and it told the user the balance starts at zero. Merged `main` at `3b2b187` into the branch and changed #15 to follow the contract in `codex-log.md` exactly. No backend files changed.

### What changed

- `packages/shared/src/api/index.ts`: `ManualAccountRequest` now has required `idempotencyKey` and `currentBalance` (an amount with `asOf`, or `null` for unknown), optional `subtype`, `openingBalance` and `includeInNetWorth`. Removed the proposed `mask`, `institutionName` and bare `balance`. `MANUAL_ACCOUNT_TYPES` is the backend's full list. New `ManualOpeningBalance`, `ManualCurrentBalance`, `ManualBalanceInfo`, `AccountWithManualBalance`; `ManualAccountResponse` is `{ account, replayed }`. The shapes match `backend/src/services/accounts.ts`.
- `apps/mobile/src/features/import/NewAccountForm.tsx` (rewritten): name, type, kind (NRE, NRO, Demat, 401(k) and so on, per type), currency, then a required answer to "Do you know the balance today?". Unknown is sent as `null`. Known asks for the amount and its date, with a switch for net worth. An optional opening balance asks for an amount and date. Amounts go out as integer minor units. Nothing is assumed to be zero, and nothing is taken from the rows of a file.
- `apps/mobile/src/features/import/pendingAccount.ts` (new): the whole original request, key and timestamps included, is stored before it is sent and kept until the outcome is known, tied to the backend it was sent to.
- `apps/mobile/src/features/import/useImportFlow.ts`: 201 and a replayed 200 both select the account. No answer or a server error keeps the stored request and offers "Try again", which sends it unchanged. 409 (`idempotency_conflict`, `account_missing`) is never re-sent and the key is never swapped by the app; the person is told to look in Accounts and can forget the request. A 400 or 401 clears it, because nothing was made. A stored request from an earlier session is offered again when the screen opens. The name-based `account_exists` handling is gone.
- `apps/mobile/src/features/import/DestinationCard.tsx`: "New account" is also offered for each account named in a Monefy or QIF file, with the name filled in and the currency fixed to the file's. While one creation is undecided, no other can be started.
- `apps/mobile/src/data/manualBalance.ts` (new), `features/accounts/AccountsScreen.tsx`, `AccountDetailScreen.tsx`: an account with `manualBalance.currentKnown === false` shows "Balance unknown" in the list and "Unknown" on its page, never 0, and adds nothing to its group total. A hand-entered balance shows the date it was true; an opening reading is shown as a line of text.
- `apps/mobile/src/design/components/Controls.tsx`: one line (`minWidth: 0` on the text input) so a field in a half-width column does not spill over its edge on the web.

### Defaults chosen

- The date entered for a known balance is sent as noon UTC of that day (`2026-11-01T12:00:00.000Z`), so it reads as the same calendar date in India and the US.
- The form offers nine types (savings, checking, credit card, loan, mortgage, brokerage, retirement, other, other debt). The Worker also accepts crypto, property and vehicle; those are not statement accounts.
- Kind is a fixed list per type, or none. No free-text kind.
- Net worth: on by default for a known balance, with a switch; never sent for an unknown one (the Worker defaults it to off and refuses on).
- For a liability the form asks for "amount owed" as a positive number, as the contract says.
- The route check still sends an empty body once per backend (400 means the route exists, 404 means it does not). It is safe now that the form matches.

### Validation

- `npm run check` passed: typecheck, lint, format and **928 tests** (shared 118, connectors 345, backend 222, deployment/runtime 35, mobile 208).
- Mobile tests rewritten for the contract: exact set of fields sent, unknown as `null`, minor units and dates for known and opening balances, the balance question required, lost answer then the identical request again, a stored request after reopening, another backend's request ignored, conflict never re-sent, a refused request dropped, a new account for one Monefy source. New tests for the unknown-balance display. Two guards were removed in turn to confirm tests fail without them.
- Web build against a local Worker running the merged backend (migration `0005` applied), invented data:
  - Savings, NRE, INR, balance unknown, opening ₹200 on 2025-01-01: accepted with 201; stored as unknown, out of net worth, opening reading kept and not a transaction; selected as the destination; a CSV imported into it; balance still unknown afterwards.
  - Known balance ₹450 dated 2026-11-01 with the answer dropped on purpose: "Not sure" shown; after reloading the page the stored request was offered and sent byte for byte the same; the Worker replayed it; exactly one account existed; balance and date as entered.
  - Accounts list shows "Balance unknown"; the account page shows "Unknown" with the opening reading, and the known account shows its date.
- Not run on an Android device or emulator.

### Remaining

- Items 2 to 8 of the previous entry's list for Codex are unchanged.
- Editing a hand-made account later (entering a balance for one created as unknown, renaming, removing) has no backend operation yet; it is Phase 5 work on both sides.
- Older accounts made by a Monefy import have no `manualBalance`, so they still show a balance of zero. Codex chose not to relabel them; a backend decision is needed if they should read as unknown too.

## 2026-11-13 — PR A: safer linking on the phone (mobile half of findings 10 and 11)

Started from `main` at `3804a7a` (PRs #14, #15 and #16 verified as merged on GitHub) on `claude/modest-babbage-iv591f`. Codex is not available, so this is only the phone's half of findings **10** (Sophtron) and **11** (SnapTrade). Changed: `apps/mobile/src/features/link/` and this log. No backend, connector, shared, workflow, root-config, dependency or lockfile changes. The backend halves are not assumed to exist.

### What changed

Sophtron (finding 10):

- `apps/mobile/src/features/link/sophtronPoll.ts` (new): the wait for a sign-in. `pollSophtron` sends one `GET /v1/link/sophtron/:linkId`, waits for its answer, pauses 3 seconds and only then sends the next. The old screen fired a request every 3 seconds whether or not the last one had answered, so two could reach the Worker together, and the one that lost the race got `done` with no connection.
  - A request that gets no answer or a Worker error (HTTP 5xx) is tried again. Three in a row stop the wait.
  - The wait stops after 60 requests or 5 minutes. Before, the spinner stayed up after the limit with nothing behind it.
  - A 404 (sign-in expired), 401 or a changed backend ends the attempt and goes back to the start with the Worker's message.
  - Leaving the screen stops it.
- `apps/mobile/src/features/link/SophtronFlow.tsx`: new steps.
  - **Stalled:** the message, **Check again** (asks about the same sign-in; no second sign-in at the bank) and **Start over**.
  - **`done` without connection IDs:** the app reloads the dataset (up to three times, 2 seconds apart) and looks. For a repair, the connection being repaired must show `healthy` or `syncing`. For a new login, exactly one Sophtron connection must be there that was not on screen when the sign-in started (the one with the picked bank's name if several are new). Found: the flow carries on to the sync step. Not found: **Not confirmed**, in plain words, with **Look again** and **Start over**. It says separately when the data could not be reloaded at all. Nothing is written in either case, so a repair that is not confirmed keeps its connection and its error.

SnapTrade and Zerodha (finding 11):

- `apps/mobile/src/features/link/BrowserFlow.tsx`: on the phone, `POST /v1/link/snaptrade/:linkId/complete` is sent only when the browser came back with `status=ok`. Before, it was sent after any closed window, and for a repair the Worker answers that with "repaired" without checking.
  - Repair, window closed or cancelled: "closed before the login finished, so nothing was changed. This connection still needs repair." No complete call, no Done button, only Open SnapTrade again.
  - New link, window closed: nothing is sent by itself. A button **I finished in SnapTrade** sends complete on your own tap. That is safe today: for a new link the Worker only saves a brokerage that is really new and otherwise answers `not_finished`.
  - Zerodha, window closed on the phone: the same message; no reload and no "linked".
  - Web: unchanged in shape (the page opens in a new tab and Done is your own tap), because the web build has no way to learn that the tab was closed.
- `apps/mobile/src/features/link/SyncStep.tsx`: for a repair the sync is now the proof. While it runs the screen says "Checking the login with a sync...", not "Repaired". "Repaired and synced" appears only after a sync with outcome `ok`. Anything else, including `skipped`, shows **The repair is not confirmed** with the Worker's reason. This covers the web's Done tap on a repair, where the Worker still marks the connection repaired unchecked. A new link keeps its wording.
- `apps/mobile/src/features/link/repair.ts`: the one-tap Zerodha repair said "Zerodha is connected again" whatever the sync answered. It now says that only for outcome `ok`.
- `apps/mobile/src/features/link/types.ts`: a small `sentence()` helper so a Worker message without a full stop reads properly before the app's own sentence.

### Defaults chosen

- The pause between an answer and the next status request stays 3 seconds; limits are 60 requests or 5 minutes, and three failed requests in a row.
- A new Sophtron connection is recognised by difference with what was on screen when the sign-in started. If the data on screen was not the selected backend's (sample data, first load not in yet), the app does not guess and reports not confirmed.
- A repair found as `healthy` or `syncing` after the reload counts as confirmed; the forced sync that follows is still the proof shown to the user.
- After a cancelled SnapTrade repair there is deliberately no "I finished" button on the phone, because the current Worker would accept it unchecked.
- "Repaired" wording changed for every connector's repair, not only SnapTrade, since the same sync step serves all of them.

### Validation

- `npm run check` passed: typecheck, lint, format and **955 tests** (shared 118, connectors 345, backend 222, deployment/runtime 35, mobile 235, up from 208). ESLint needed `NODE_OPTIONS=--max-old-space-size=8192` in the cloud container, as before; no config change.
- New `apps/mobile/src/features/link/__tests__/linkSafety.test.tsx` (27 tests, invented data): one status request at a time with held answers; no requests after leaving; retry after a lost answer; stop after three failures and Check again on the same sign-in; stop at the limit; expired sign-in; `done` without IDs found after a reload, found by bank name among two, not found, data not reloadable, sample data on screen, repair still in error then confirmed, another new connection not mistaken for the repaired one; SnapTrade finished, cancelled and dismissed repair, closed new link then own tap, own tap with nothing new, error callback, Zerodha closed, web Done; the sync step for a repair with outcomes ok, needs_repair, error and skipped; the Zerodha one-tap repair.
- Each guard was removed in turn to confirm a test fails without it: old `BrowserFlow` (5 failures), old `SyncStep` (5), old `repair.ts` (1), overlapping status requests (2), repair accepted without a status check (2), new-connection guess with sample data on screen (1), no failure limit (1).
- Exported web build against a local Worker (`wrangler dev --local`, throwaway `.dev.vars`, `ALLOW_SAMPLE_SEED=true`, `POST /v1/dev/seed`), at 412 px and 1280 px. The dataset and sync calls went to the real local Worker. The `/v1/link` routes that talk to Sophtron and SnapTrade were answered in the browser with invented data, because no provider may be called and the local Worker has no provider keys. 14 checks passed:
  - Sophtron repair with answers slower than the pause (4.5 s) and one lost answer: never more than one status request in flight, each sent about 3 s after the previous answer, 4 status requests and 1 start, then `done` without IDs led to a dataset reload and "Not confirmed"; no further requests afterwards. After the dataset showed the connection as syncing, Look again went on to the sync step, which said "Checking the login with a sync..." and ended as "The repair is not confirmed" because the local Worker has no Sophtron keys.
  - Sophtron new login: `done` without IDs and nothing new said so plainly; after a new connection appeared in the dataset, Look again carried on.
  - SnapTrade repair on the web: opening the page sent no complete; Done sent exactly one; the sync step never said "Repaired" and ended as "The repair is not confirmed".
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted afterwards; none is committed.
- **No Android device or emulator was used.** The phone-only path (the in-app browser closing or being cancelled) is covered by the Jest tests with a stand-in browser, not by a real Custom Tab.

### Still needed from Codex for findings 10 and 11

- **Sophtron:** store the result of the request that finishes a sign-in and return it again (connection IDs and `repaired`) on later status requests, and make a half-finished finalisation recoverable. Today `sophtronStatus` in `backend/src/api/link.ts` moves the session to `done` before the connection is made and later answers `done` with no IDs. The phone's reload-and-look is a fallback for that, not a replacement.
- **SnapTrade:** in the repair branch of `POST /v1/link/snaptrade/:linkId/complete`, check that the saved authorization is present and enabled before `markRepaired`, and answer with an error otherwise. Until then a Done tap on the web marks the connection repaired for the moment before the sync corrects it. A status the app could read for a browser session (returned or not) would also let the web build tell a finished login from a closed tab.

### Not possible until Codex is back (not built)

Entering a balance later for an account made as unknown; renaming or removing a hand-made account; cash deletion; category merging; export and backup; the status panel; update notices; per-account history dates; attaching a provider account to an existing account; and items 2 to 8 under "What Codex needs to do" above.

### Next (in the order Sankar set, one PR at a time)

PR B import follow-up (leave out single rows; `docs/setup.md` section), PR C alerts and stored statements, PR D categories and rules, PR E Ask AI, PR F transaction editing controls.

## 2026-11-13: Blocks B and C (leave out single import rows, alerts, stored statements)

Started from `main` at `e6e824f` (PRs #14, #15, #16 and #17 verified as merged on GitHub) on `claude/vigilant-hopper-biu3nv`. Main moved to `03405d0` during the work (Codex's PR #18) and the branch was brought up to it before the first commit. One pull request with one commit per block. Codex is not available, so everything here uses routes that already exist in `backend/src/api/`. Changed: `apps/mobile/`, the one authorized section of `docs/setup.md`, and this log. No backend, connector, shared, workflow, root-config, dependency or lockfile changes. `packages/shared/src/api/index.ts` already had every type needed (`Alert`, `AlertsResponse`, `VaultListResponse`, `ImportRecord`, `ImportCommitRequest`), so it was not touched.

### Block B: import follow-up

What changed:

- `apps/mobile/src/features/import/importFlow.ts`: `Review` gains `leftOut`, the rows unticked one by one, kept by the file's line number together with the row as it read at that moment. `commitLines` sends them in `skipLines` (the Worker already accepts that), only for lines that are rows of the preview on screen. New `rowChoices` (which rows get a tick box), `duplicateAnswer` (an unticked row that is also a possible duplicate counts as "skip the file's row"), `carryLeftOut` (what happens to unticked rows after a new preview) and `markOf`. `planImport` reports `leftOutByHand` and `unreadableLeftOut`.
- `apps/mobile/src/features/import/useImportFlow.ts`: `leaveOut(line, out)` and `putRowsBack()`. A keep-or-skip answer replaces an earlier untick of the same row. Unticked rows are carried through every new preview, including the one made after the Worker reports that transactions changed.
- `apps/mobile/src/features/import/PreviewCard.tsx`: every row that is not settled elsewhere has a tick box (role checkbox, with the line number and description as its label). Unticked rows are greyed and badged "Left out". A line under the totals says how many rows you left out and offers "Put them back". The list shows 60 rows and then "Show 100 more", so every row of a long file can be reached; the note next to the button says the counts and totals are for the whole file.
- `apps/mobile/src/features/import/ReviewCards.tsx`: the duplicates card shows an unticked row as "Will be left out" and counts it as answered.
- `apps/mobile/src/features/import/ImportScreen.tsx`: passes the two new actions to the preview.
- `docs/setup.md`: the section "India NRE and NRO statements" was replaced with the text Sankar supplied ("Monefy history and India NRE and NRO statements"). Nothing else in that file changed.

How counts and totals stay right:

- The counts line, the totals per account and currency, the Import button's row count and the totals shown with the result all come from the same `planImport`, which leaves out exactly the lines `commitLines` sends. The preview now says "N left out (R rows, U unreadable lines)" when unreadable lines are among them, so the number matches the "left out" figure the Worker reports after the save.
- A line is never sent twice, and never as both kept and skipped. An untick outranks an older "keep" for the same line.
- Rows that are already stored, rows whose account is left out as a whole, and possible duplicates have no tick box: each is decided in one place only.

Defaults chosen:

- A CSV, OFX or QIF line number is the same line of the same file in every preview (checked in `packages/shared/src/import/{csv,ofx,qif}.ts` and `backend/src/imports/monefy.ts`), so an unticked row stays left out when the dates, the destination, the date order or the columns change. A row that falls outside narrower dates is remembered and is still left out when the dates are widened again.
- A PDF is read again by Workers AI for every preview and its rows are numbered in the order they come back (`packages/shared/src/import/statement.ts`). There a row stays left out only if the same row (date, amount, description, account) is still at that number. Otherwise it is put back in and the screen says how many, so nothing is left out by guesswork.
- Picking another file or "Start over" forgets the unticked rows.
- A row with no account can be unticked, which removes that reason not to save.
- "Put them back" restores every unticked row at once; one row is restored by ticking it.

### Block C: alerts and stored statements

Read first: `backend/src/api/app.ts` (the four routes), `backend/src/ai/jobs/alerts.ts` and `recurring.ts` (what makes an alert and what its `amount` means), `backend/src/imports/service.ts` (`listImports`, `loadRecord`) and migration `0001` (the `alerts` table).

Alerts (`GET /v1/alerts`, `POST /v1/alerts/:id/dismiss`):

- `apps/mobile/src/features/alerts/alertsApi.ts`, `alertsStore.ts`: the list is read from the Worker, kept in memory only, shared by Home and the Alerts screen, and dropped the moment the backend changes or the token is forgotten. Calls made at the same moment share one request.
- `apps/mobile/src/features/alerts/AlertsScreen.tsx` and route `apps/mobile/src/app/alerts/index.tsx`: kind ("Possible duplicate", "Unusual charge", "Price went up"; an unknown kind shows as "Alert"), the Worker's message, the amount through `Amount` (labelled "Charged", or "More than before" for a price rise, because that is what the Worker stores there), the day it was raised, the transaction's name, date and account when it is in the data on the device, "See the transaction" (only then), "See recurring" when the alert names a recurring item, and Dismiss. Pull to refresh and a reload button. When exactly 100 are listed it says these are the newest 100.
- Dismiss sends the request at once and removes the alert only after the Worker confirmed. If the Worker cannot be reached the alert stays and the reason is shown. A list that was asked for before a dismissal cannot bring the alert back.
- `apps/mobile/src/features/alerts/AlertsEntry.tsx`, added to `features/dashboard/DashboardScreen.tsx` in both layouts.

Stored statements (`GET /v1/vault`, `GET /v1/vault/:id/file`):

- `apps/mobile/src/features/vault/vaultApi.ts`, `vaultStore.ts`, `vaultFiles.ts`, `labels.ts`: `GET /v1/vault` sends one record per stored copy and every preview stores its own copy, so the app groups records with the same SHA-256 into one file and shows it by its most telling copy (a saved import before a save under way, before an undone one, before a failed one, before a preview).
- `apps/mobile/src/features/vault/VaultScreen.tsx` and route `src/app/vault/index.tsx`: one row per file with its kind, size, the day it was stored and what became of it (Imported, Import undone, Saving, Could not be read, Not imported). When the Worker's list is full (200 records) the screen says older files are kept but not listed.
- `apps/mobile/src/features/vault/VaultFileScreen.tsx` and route `src/app/vault/[id].tsx`: the facts, every import of that file with its counts, how often it was only previewed, and two ways to open it:
  - **Show the contents** (CSV, OFX, QIF): the text is fetched with the token and shown in the app, first 300 lines, with the full line count. Nothing is written to the device.
  - **Open in another app** (phone, `openStoredFile.ts`): the file is downloaded into the app's private cache with `File.downloadFileAsync` and handed to another app with `File.canPreview` / `File.preview`, both part of the `expo-file-system` version already installed (58.0.13). A PDF can only be opened this way. One copy stays in the cache until another file is opened or the list is opened again. If no app opens that kind of file, the screen says so and keeps no copy.
  - **Download the file** (web, `openStoredFile.web.ts`): fetched with the token and saved through the browser under its own name.
- `apps/mobile/src/features/import/ImportScreen.tsx` and `ImportHistory.tsx`: the two ways in from the History tab. `features/accounts/AccountsScreen.tsx`: the button on the Connectors tab.
- `apps/mobile/src/data/backend/client.ts`: one word, `export` on the existing `supersededError()`, so the file request (which returns bytes and cannot go through `api()`) reports a changed backend the same way.
- An answer or a download that arrives after the backend changed is thrown away and never shown or opened.

Where the screens are reached from (my choice):

- **Alerts:** a row on Home, in both layouts, whenever a backend is set. It reads "3 alerts", or "No alerts" when there are none, so the screen is always in the same place. It reloads when the app's data is loaded again.
- **Stored statements:** Accounts, Connectors tab, next to "Import a statement"; and Import a statement, History tab ("Stored statements" at the top, "See the file" on each import).

Other defaults:

- Dismiss is one tap with no confirmation and no undo, because the Worker has no route to bring an alert back. The screen says "A dismissed alert does not come back."
- No "check now" button. `POST /v1/ai/jobs/alerts` exists, but this block was list and dismiss only; the Worker runs that job once a day.
- Dates are shown as the Worker's UTC day, as History already does.
- Files never saved (previewed and cancelled) are listed too, as "Not imported", because they are in the vault.

### Validation

- Main moved to `03405d0` during the work (Codex's PR #18, recovery tooling under `backend/recovery/`; no route, shared or mobile change). The branch was brought up to it before committing, and the checks below were run again on top of it.
- `npm run check` passed: typecheck, lint, format and **1,033 tests** (shared 118, connectors 345, backend 222, deployment, runtime and recovery 46, mobile 302, up from 235). ESLint needed `NODE_OPTIONS=--max-old-space-size=8192` in the cloud container, as before; no config change.
- New mobile tests, all with invented data: `importFlow.test.ts` +11 and `import.test.tsx` +7 (block B and the History links), `features/alerts/__tests__/alerts.test.tsx` (16), `features/vault/__tests__/vaultFiles.test.ts` (11), `vault.test.tsx` (17, with a stand-in for the phone's file system), `openStoredFile.web.test.ts` (3), and one each in the accounts and dashboard tests for the new ways in.
- Each guard was removed in turn to confirm a test fails without it.
  - Block B: unticked rows not sent (12 failures), an untick not counted as a duplicate answer (2), a tick box on a possible duplicate (3), PDF rows never put back (2), a keep answer not clearing the untick (1), unticked rows dropped on a new preview (3), unreadable lines missing from the left-out count (2).
  - Alerts: a list asked for earlier bringing a dismissed alert back (1), alerts kept after a backend change (2), a late failure shown on the new backend (1), a load attempted with no backend (1), the same alert dismissed twice (1), an alert removed before the Worker confirmed (2), the Home row shown with no backend (1), two callers not sharing one request (1), the row missing from the safe-to-spend layout (1).
  - Stored statements: the list kept after a backend change (2), a file answer accepted after a backend change (1), a download opened after a backend change (1), earlier copies not cleared before a new open (1), a copy kept when no app opens it (1), a copy kept after returning to the list (1), a failed download leaving a partial file (1), a PDF offered as text (2).
  - Not covered by a removal: the store's own check on a list answer after a backend change sits behind the same check in `api()`, so removing it alone fails nothing. The web build's `aria-checked` on the tick box cannot be seen by Jest (the phone renderer folds it into the native state); the browser checks cover it and failed before it was added.
- Exported web build against a local Worker (`wrangler dev --local`, throwaway `backend/.dev.vars`, `ALLOW_SAMPLE_SEED=true`, `POST /v1/dev/seed`), at 412 px and 1280 px, real multipart uploads and real Worker answers. **50 of 50 checks passed.**
  - Import: a nine-line invented bank CSV (seven readable rows, one of which looks like a stored transaction, and one row with an unreadable date) into the sample NRE account. Counts and the INR totals were compared with sums worked out by the script at every step: before any untick, after unticking two rows, after a new preview with narrower dates (one unticked row outside them), after widening again (both still unticked), and with the duplicate skipped and the unreadable line acknowledged ("4 to import · 4 left out (3 rows, 1 unreadable line)"). The save sent `skipLines` 4, 6, 8, 9. The Worker's record read 4 added and 4 skipped, the four saved rows were in the account and the four left out were not. The same file again offered exactly the rows left out (3 to import, 4 already there).
  - Stored statements: opened from History, facts and history shown, the text shown on screen (9 lines), the download compared byte for byte with the original, five stored copies shown as one file, an unknown id reported as not found, an unreachable Worker reported with nothing shown.
  - Alerts: three invented alerts put into the local database (no provider, no AI). Home showed "3 alerts"; the screen listed kind, message and amount; "See the transaction" opened it; an alert whose transaction is not loaded had no link; a dismissal that could not reach the Worker changed nothing; a real dismissal sent one POST and the alert was gone from the screen, from the Worker's list and after a page reload; Home followed. With no backend set, both screens asked for it, Home had no row and nothing was sent.
  - This run found one fault, fixed before committing: on the web the tick box did not say whether it was ticked to assistive technology.
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted afterwards; none is committed.
- **No Android device or emulator was used.** "Open in another app" on the phone is covered only by Jest with a stand-in file system; the real download, the hand-over to a PDF viewer and the cache clean-up have not run on a device. PDF import was not exercised (it needs Workers AI on Cloudflare), so the PDF rule for unticked rows is covered by tests only.

### For Codex (found while building; none of it blocks this PR)

- **Alerts:** there is no way to list dismissed alerts or to undo a dismissal, so a mistaken tap cannot be taken back. `POST /v1/alerts/:id/dismiss` answers `{ ok: true }` for an id that does not exist. The list stops at 100 with no total and no paging. An alert carries only ids, so when its transaction is not in the app's dataset there is nothing to show but the message.
- **Vault:** `GET /v1/vault` returns one record per stored copy (each preview stores another copy of the same file) and stops at 200 records, so a file can drop off the list after enough previews. A listing of distinct files, or paging, would fix that; it is the same root as item 4 below (previews pile up). There is no operation to delete a stored file.
- **PDF previews:** rows are numbered in the order Workers AI returns them, so a second preview of the same PDF may number them differently. Keeping the first reading for a re-preview of the same file (same SHA-256) would let per-row choices survive.
- Unchanged from the earlier entries: items 2 to 8 under "What Codex needs to do" (item 3, one unreadable date hiding the date format, showed again in this browser run: the file had to be given its date format by hand), and the backend halves of findings 10 and 11.

### Not possible until Codex is back (not built)

Entering a balance later for an account made as unknown; renaming or removing a hand-made account; cash deletion; category merging; export and backup in the app (Codex's PR #18 is an operator tool and says not to expose it as a phone button); the status panel; update notices; per-account history dates; attaching a provider account to an existing account; undoing an alert dismissal; deleting a stored file.

### Next (in the order Sankar set, one at a time)

D categories and rules, E Ask AI, F the transaction editing controls that `PATCH /v1/transactions/:id` supports and the app does not expose yet.

## 2026-11-13: Blocks D and E (categories and rules, Ask AI)

Started from `main` at `372d1fe` (PRs #18, #19 and #20 verified as merged on GitHub) on `claude/fervent-hypatia-vl2qsq`. One pull request with one commit per block; this log entry and the three authorized `AGENTS.md` lines are in the block E commit. Everything is built on routes that already exist in `backend/src/api/app.ts`; nothing of Codex's unmerged work is used. Changed: `apps/mobile/`, `packages/shared/src/api/index.ts` (additive types only), `AGENTS.md` (the three lines Sankar gave, word for word) and this log. No backend, connector, workflow, root-config, dependency or lockfile changes.

### Shared types added (`packages/shared/src/api/index.ts`)

For routes that exist and had no type, matching what the Worker sends: `CategoriesResponse` (GET /v1/categories), `CategoryResponse` (POST and PATCH /v1/categories), `CategoryPatchRequest` (the four keys PATCH takes), `RulesResponse` (GET /v1/rules), `RuleRunResponse` (POST /v1/rules/run). Existing `CreateCategoryRequest`, `RuleInput`, `RuleResponse`, `AiStatusResponse`, `AskRequest` and `AskResponse` are reused. Nothing renamed, removed or reshaped.

### Block D: categories and rules

Read first: the routes in `backend/src/api/app.ts` (schemas `conditionSchema`, `actionSchema`, `ruleSchema`, the category POST and PATCH schemas), `backend/src/services/rules.ts` (`runRules`), `packages/shared/src/policy/rules.ts` (`applyRules`, `conditionMatches`) and `backend/src/services/edits.ts` (how learned rules are written).

- `apps/mobile/src/data/backend/scopedStore.ts` (new, shared app folder, additive): a value read from the Worker, kept in memory only, dropped the moment the backend changes; writes change the screen only from the Worker's answer; a list asked for before a confirmed write cannot undo it on screen. Used by categories, rules and the AI status.
- `apps/mobile/src/features/categories/` (new) and route `src/app/categories/index.tsx`:
  - The list is `GET /v1/categories`, grouped by the groups in the app's data, every group shown (empty ones too), archived categories in their own section with "Bring back".
  - Tap a category: rename (`{ name }`, trimmed), "Leave out of budgets" (`{ excludeFromBudget }`), Archive (`{ archived: true }`). Up and down arrows send `{ order }` to each category whose value changes (two PATCHes for a move; values made strictly increasing so categories that share 999 still move). A failed PATCH stops the rest and reloads the list.
  - "Add a category": name, an existing group, colour (12 slots), icon (the 40 the app can draw), leave out of budgets. Kind is the group's kind. Order is after the last category of the group. Sent only while the data on screen is this backend's (the group ids come from it).
  - After a confirmed change the category is also put into the app's own data, so pickers and budgets see it at once; never into sample data.
- `apps/mobile/src/features/rules/` (new) and routes `src/app/rules/index.tsx`, `src/app/rules/[id].tsx`:
  - List (`GET /v1/rules`): name, "Off" and "Learned" badges, a one-line summary with names from the app's data, an on/off switch (PUT of the whole stored rule with `enabled` changed), "Add a rule", "Apply rules to stored transactions" (`POST /v1/rules/run`).
  - Form (`/rules/new`, `/rules/<id>`): name, on, priority, every or any condition, conditions and actions. Offered exactly what the schema allows: name or the bank's name with contains, is exactly, starts with, matches the pattern, and upper/lower case exactly; amount is exactly, over, under, between; account, category, currency as one (`equals`) or several (`in`); actions set the category, rename, set the kind (all five kinds), add a tag (existing tags only), mark as reviewed, leave out of reports and budgets. Limits 1 to 20 conditions, 1 to 10 actions, 200 characters.
  - Every save and run shows the Worker's count: "Saved "X". Rules changed N transactions." When N is above 0 the app's data is reloaded.
  - Delete asks once more and says that what the rule changed stays.

Where the screens are reached from (my choice): Settings, a new "Categories and rules" group above AI (`features/settings/sections/OrganizeSection.tsx`, one line in `SettingsScreen.tsx`).

Defaults chosen (block D):

- A name already used in the same group (archived ones included) is refused before sending, pointing to "Bring back" for an archived one. The Worker itself accepts duplicates.
- Icon and colour are chosen only when adding, because PATCH cannot change them. Default icon `tag`, default colour the first slot the group does not use.
- Reordering is one step up or down per tap. No drag.
- Rule amounts are typed with two decimals (USD and INR both have two) and compared by the Worker as the size of the amount, in the transaction's own currency. A negative amount is refused with that reason; a stored rule with a negative amount (the sample learned Venmo rule has one) shows as it is, and its form asks for the size before it can be saved again.
- A pattern that JavaScript cannot read is refused, since the Worker would treat it as never matching.
- An action type the rule already has is not offered again (the Worker would ignore the second), except add a tag with another tag.
- New rules use priority 100, as the Worker does. `?apply=false` on POST is not used: every save applies.
- Rule forms and adding a category are closed while the data on screen is not this backend's, because the ids would be the sample data's.
- Saving, adding and deleting ignore a second tap made before the first answer.

### Block E: Ask AI

Read first: `POST /v1/ai/ask`, `GET /v1/ai/status`, the error mapping in `app.ts` (409 `ai_disabled`, 503 `ai_unavailable`), `backend/src/ai/jobs/ask.ts` (what is sent to the AI) and `backend/src/ai/provider.ts`.

- `apps/mobile/src/features/ask/` (new) and route `src/app/ask/index.tsx`.
- Status card from `GET /v1/ai/status`: "AI is on, using Workers AI" or the other provider, a line when that provider has no key or binding on the Worker, "Today: N of 300 Workers AI calls used" (with: every AI job counts, the count starts again at midnight UTC; for another provider: the count does not cover it), and "Today's allowance is used up" at the limit. When AI is off: "AI is off", the Ask button is greyed and "Open Settings" is offered.
- Question field (3 to 500 characters, trimmed), three example questions, Ask. The answer shows under its question, newest first; Clear removes them.
- 409 `ai_disabled`: "AI is switched off on your Worker, so nothing was sent to any AI. To ask questions, turn on AI features in Settings, AI." The question stays in the field. 503 `ai_unavailable`: "The AI could not be reached, so there is no answer. The Worker said: ..." with the Worker's own reason (for example the daily allowance). Anything else: "No answer." and the plain error. The status is loaded again after every ask.
- The screen says what is sent: account names and balances and six months of totals by category, never single transactions (from `ask.ts`).
- Nothing is kept: questions and answers live only in the screen's state. No storage call, `autoComplete="off"` on the field, gone when the screen closes, cleared when the backend changes, and an answer for a backend that is no longer selected is dropped.
- Ways in (my choice): an "Ask AI" row on Home in both layouts (only with a backend set) and an "Ask AI" row at the top of Settings, AI.

Defaults chosen (block E): 90-second wait for an answer; one question at a time; Ask greyed only when the status says AI is off (if the status could not be loaded, asking is still allowed and a 409 is explained); the answer is selectable so it can be copied; nothing is offered to save a conversation (Sankar asked for that to wait).

### Validation

- `npm run check` passed: typecheck, lint, format and **1,139 tests** (shared 118, connectors 345, backend 250, deployment, runtime and recovery 46, mobile 380, up from 302). ESLint needed `NODE_OPTIONS=--max-old-space-size=8192` in the cloud container; no config change.
- New mobile tests, all with invented data: `data/backend/__tests__/scopedStore.test.ts` (5), `features/categories/__tests__/categories.test.ts` (9) and `categoriesScreen.test.tsx` (12), `features/rules/__tests__/rules.test.ts` (12) and `rulesScreen.test.tsx` (16), `features/ask/__tests__/ask.test.ts` (7) and `askScreen.test.tsx` (14), `features/settings/sections/__tests__/organize.test.tsx` (3), and the Home test checks the Ask AI row in both layouts.
- Each new guard was removed once to confirm a test fails without it:
  - Block D (17): a list asked for before a write undoing it (1 failure), a write answered for an old backend applied (1), a move carrying on after a refused PATCH (1), a category written into sample data (1), adding allowed with sample data on screen (1), a duplicate name sent (2), tied orders not moving (1), a broken pattern sent (1), a negative amount sent (1), a rule saved with sample data on screen (1), a repeated action sent (1), the data reloaded when nothing changed (1), a taken action type offered (1), a rule written into sample data (1; this one had no test at first, the test was added), double taps on Save the rule (1), Add (1) and Delete (1).
  - Block E (11): answers kept after a backend change (1), a dropped answer reported as a failure (1), Ask enabled while AI is off (1), a short question sent (1), 409 not explained (2), 503 not explained (2), the status not reloaded after asking (2), a double tap sending twice (1), the provider note for other providers (1), the Home row in the safe-to-spend layout (1), the Home row without a backend (2).
  - Not covered by a removal: the check inside Ask that AI is off sits behind the greyed button, so removing it alone fails nothing. A first version of "one question at a time" read a value from the last render and would not have stopped a fast double tap; it was replaced by one set at the moment of the tap, with a test.
- Exported web build against a local Worker (`wrangler dev --local`, throwaway `backend/.dev.vars`, `ALLOW_SAMPLE_SEED=true`, `POST /v1/dev/seed`, fresh database for each run), at 412 px and 1280 px. Every result was read back from the Worker with its own API. **98 of 98 checks passed** (block D 30 at each width, block E 19 at each width).
  - Categories: rename stored trimmed with a body of `name` only; a duplicate name refused and not sent; left out of budgets; archived and brought back; Groceries moved down and the Worker's order read Restaurants, Groceries, Coffee, as on screen; "Bakery" added to Food with icon coffee, colour c7, kind expense, order 12.
  - Rules: "Apply rules" in the app said "Rules changed 2 transactions." and an API run straight after changed 0; Payroll turned off and on with the whole rule in the PUT; a rule "Pho Corner" to Coffee: a broken pattern was refused with nothing sent, then the save said "Rules changed 12 transactions.", the number of Pho Corner rows the script worked out beforehand, and all 12 were Coffee on the Worker; the rule was edited (any condition, amount 5 to 19.99, tag Tax) and stored exactly; deleted after the second tap, and its changes stayed.
  - Ask AI: status "AI is on, using Workers AI, Today: 0 of 300"; a 2-character question refused and not sent; a real question went to the local Worker, which answered 503 `ai_unavailable` ("Binding AI needs to be run remotely"), shown in plain words, and the count went to 1; AI switched off on the Worker with the screen still saying on: Ask gave the 409 text, the status reloaded to "AI is off", Ask was greyed and sent nothing, and the 409 did not count; switched on again; localStorage and sessionStorage held nothing of the question or answer and there were no IndexedDB databases; after leaving and reopening the screen nothing was shown; the Settings and Home rows were there.
- **Only refusals were tested against the Worker for Ask AI.** The local Worker cannot run Workers AI, so every real `POST /v1/ai/ask` ended in 503. The one answer shown in the browser was played by the browser itself (an invented answer in place of the Worker's), to check how an answer is laid out and that it is not stored. A real answer from Workers AI, its wording, how long it takes and the 90-second wait have not been seen. The 409 path was tested for real.
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted afterwards; none is committed.
- **No Android device or emulator was used.**

### For Codex (found while building; none of it blocks this PR)

- **Categories:** no delete, no merge, no group editing (add, rename, reorder groups), and PATCH cannot change icon, colour, group or kind. There is no call that reorders several categories at once, so a move is two PATCHes and a failure between them leaves one moved. The Worker accepts a second category with the same name in a group and does not trim names. POST takes any string as `icon`.
- **Rules:** a save (POST or PUT, including turning a rule off) runs every enabled rule over every stored transaction, and `applied` counts the changes of all rules, not of the one saved. A count of what a rule would change before saving (a dry run) would help: in the browser test one edit changed 101 transactions. Turning a rule off or deleting it does not undo what it changed. `DELETE /v1/rules/:id` answers 204 for an id that does not exist. The schema accepts `equals` with a list and `in` with a single value (the first never matches), a negative amount (the matcher compares sizes, so `gt -5000` matches everything; the sample learned Venmo rule has this), and a pattern that cannot be read (never matches). A learned rule is written again by the next category correction for its merchant, so an edit made in the app is replaced; the form says so.
- **Tags:** the "add a tag" action can only use tags that already exist; there is no route to make one.
- **AI:** a Workers AI call that fails still counts toward the daily limit (the count goes up before the call; seen locally, 0 to 1 after a 503). A failed Anthropic request (an SDK error) and a network failure to OpenAI or a compatible service are not turned into `ai_unavailable`, so the app can only say "Something went wrong on the server" (read in `provider.ts`, not run, since no keys may be used). There is no way to ask a follow-up with the earlier question as context.
- Unchanged from earlier entries: items 2 to 8 under "What Codex needs to do", the backend halves of findings 10 and 11, and the alert, vault and PDF items of the previous entry.

### Not possible until Codex's routes exist (not built)

Entering a balance later for an account made as unknown; renaming or removing a hand-made account; cash deletion; category merging; export and backup in the app; the status panel; update notices; per-account history dates; attaching a provider account to an existing account; undoing an alert dismissal; deleting a stored file.

### Next (in the order Sankar set, one chat each)

F: the transaction editing controls that `PATCH /v1/transactions/:id` supports and the app does not expose (name, date, amount, notes, kind, tags, exclude), plus making a cash account (`POST /v1/accounts/cash`), refreshing rates now (`POST /v1/fx/refresh`) and rejecting a suggested transfer (`POST /v1/transfer-links/:id/reject`). G: screens for the account editing routes, once Codex's contract for them is merged.

## 2026-11-14: Block F (transaction editing, cash accounts, rates now, suggested transfers)

Started from `main` at `f095391` (PRs #21 and #22 merged; #22 is Codex's bounded nightly work, whose log says no route or contract changed) on `claude/fervent-hypatia-vl2qsq`, restarted from main after #21 merged. One pull request, one commit. Everything uses routes already on main: `PATCH /v1/transactions/:id`, `POST /v1/accounts/cash`, `GET /v1/fx/latest`, `POST /v1/fx/refresh`, `POST /v1/transfer-links/:id/confirm` and `/reject`. Changed: `apps/mobile/`, `packages/shared/src/api/index.ts` (two additive types) and this log. No backend, connector, workflow, root-config, dependency or lockfile changes.

### Shared types added

`TransactionResponse` (`{ transaction }`, the answer of PATCH, review and category) and `FxRefreshResponse` (`{ openExchangeRates, frankfurter }`, the counts POST /v1/fx/refresh sends). Nothing renamed, removed or reshaped.

### What changed

Editing a transaction (`PATCH /v1/transactions/:id`):

- `apps/mobile/src/features/transactions/edit.ts` (new): the form and its checks. One save sends only the fields that changed, because the Worker marks every field it receives as edited by hand and nothing changes it again.
- `EditTransactionSheet.tsx` (new), opened by a new "Edit" button on the transaction's detail sheet: name, date, amount (money out or in, in the transaction's own currency), kind (the five kinds), tags (existing tags only), "Leave out of reports and budgets", notes.
- What the Worker refuses is not offered: no amount on a linked transfer or a part of a split, no kind on a linked transfer, and on a split whole only name and notes.
- `actions.ts`: `editTransaction` changes the screen at once and sends the PATCH through the existing `persist`, so a refused save is undone and the banner says why. The detail sheet now also shows the kind (when not regular), the tags and a "Left out of reports" badge.

Suggested transfers (`POST /v1/transfer-links/:id/confirm` and `/reject`):

- Found while reading the matcher: the Worker stores a suggested pair without setting `transfer_link_id` on either transaction (`backend/src/services/matcher.ts`), but the app looked for suggestions only through that field. So suggestions from the Worker were never shown, and the old "Not a transfer" button sent `POST /v1/transactions/:id/unlink`, which answers 400 "This transaction is not linked." for them (checked on the local Worker).
- `transfers.ts`: `suggestionsFor` and `openSuggestions` find suggested pairs by their two ids. `applyRejectSuggestion` marks only that pair rejected. `applyConfirmTransfer` now does what the Worker does: points both sides at the pair and drops the other suggestions involving either side.
- `TransferSection.tsx`: every suggested pair is shown with the other side's account, name, date and amount, and its own "Confirm" and "Not this one" ("Not a transfer" when there is one). Turning down uses the reject route.
- `PossibleTransfersScreen.tsx` (new) and route `src/app/transactions/transfers.tsx`: all open suggestions grouped by the payment out. Reached from a "Possible transfers · N" chip on Transactions, shown only when there are some.

Cash accounts (`POST /v1/accounts/cash`):

- `features/accounts/cashAccount.ts`, `actions.ts`, `CashAccountSheet.tsx` (new), opened by "Add a cash account" on Accounts, Connectors tab: name, currency (USD, INR, then any other in use), cash on hand now, and "Use for quick cash entries in X". Made on the Worker first, then put into the app's data (never into sample data) and the data reloaded.

Exchange rates (`GET /v1/fx/latest`, `POST /v1/fx/refresh`):

- `features/currency/fxApi.ts` and `features/settings/sections/ExchangeRatesSection.tsx` (new, one line in `SettingsScreen.tsx`, below Display): the USD to INR rate the Worker has, when and by whom it was published, and "Refresh rates now", which says in plain words what each source gave, then reloads the rate (and the app's data when something came back).

### Defaults chosen

- Dates: a real calendar day, not after today. Amounts: not zero, at most the currency's decimals, typed without a sign with "Money out" or "Money in".
- Notes cleared to empty are sent as `null`. Tags are compared as a set; a tag the device does not know stays on the transaction.
- The edit form always opens from the transaction as it is now; "Cancel" keeps nothing.
- The edit sheet says that editing an amount does not change the account balance (the route does not).
- Suggestions are listed best match first. A pair whose other side is not in the app's data is not shown, since it could not be judged.
- Cash account: the cash on hand is required (0 is accepted, below 0 is not), the name must not be one an account already has, and "quick cash entries" is offered only when that currency has no such account yet, because the Worker does not take the mark off the other one. A second tap before the answer is ignored. When the answer is lost the form says the account may exist and asks to check Accounts before trying again; it never sends again by itself.
- Rates: the pair shown is USD to INR. No button when no backend is set.

### Validation

- `npm run check` passed: typecheck, lint, format and **1,200 tests** (shared 118, connectors 345, backend 271, deployment, runtime and recovery 46, mobile 420, up from 380). ESLint needed `NODE_OPTIONS=--max-old-space-size=8192` in the cloud container; no config change.
- 40 new mobile tests, all with invented data: `transactions/__tests__/edit.test.ts` (11), `editSheet.test.tsx` (6), `suggestions.test.tsx` (7, suggestions in the Worker's shape, without the pointer), `accounts/__tests__/cashAccount.test.tsx` (9), `settings/sections/__tests__/exchangeRates.test.tsx` (6), and one in `accounts.test.tsx` for the new button. A small helper (`transactions/__tests__/live.ts`) loads invented data from a stand-in Worker so saves really go out.
- Each of 27 new guards was removed once to confirm a test fails without it: only changed fields sent (7 failures), real date (2), not after today (1), not zero (1), sign from money out or in (7), amount lock (1), kind lock (1), split whole (1), tags as a set (1), unknown tags kept (1), fields marked as edited (1), form reset on open (1), suggestions found by ids (2), the reject route (2), confirm drops other suggestions (1), confirm points both sides (2), reject marks only that pair (3), suggestions with a side not on the device left out (1), cash default only when none (1), cash double tap (1), cash form waits for this backend's data (1), lost-answer wording (1), cash account never into sample data (1), negative cash refused (1), duplicate cash name refused (1), app data reloaded only when rates came back (1), rate reloaded after a refresh (1). Three of these had no test at first (kind lock, a side not on the device, sample data); the tests were added.
- Exported web build against a local Worker (`wrangler dev --local`, throwaway `backend/.dev.vars`, `ALLOW_SAMPLE_SEED=true`, `POST /v1/dev/seed`, a fresh database per run), at 412 px and 1280 px. Every result was read back from the Worker's own API. **46 of 46 checks passed (23 at each width).** The ambiguous pair was made with the Worker's own PATCH route (two arrivals of the same amount on the same day in two accounts) and `POST /v1/transfer-links/run`, which reported 2 suggestions.
  - Editing: an impossible date refused with nothing sent; one PATCH carrying exactly name, notes, amount, excluded and tags; all stored, each listed in `userEditedFields`; a rule made afterwards to rename that transaction left the edited name alone; a date change stored; a linked transfer offered no amount.
  - Suggestions: "Possible transfers · 1" on Transactions; both pairs on the payment's detail; "Not this one" sent only `POST /v1/transfer-links/<id>/reject` (no unlink), and the Worker held that pair rejected and the other still suggested; "Confirm" on the list confirmed it on the Worker with both sides pointing at it; the list then read "Nothing to check"; running the matcher again suggested nothing.
  - Cash account: INR already had a quick-entry account, so the switch was not offered; a double tap sent one POST with `{ name, currency: 'INR', balance: 250000, isDefault: false }`; exactly one cash account on the Worker; listed on the Accounts tab.
  - Rates: Settings showed the Worker's own USD to INR rate. The refresh answer was played by the browser (`{ openExchangeRates: 0, frankfurter: 30 }`), so no public rate source was called; the result text and the reload of the rate were checked. **The real `POST /v1/fx/refresh` was not called.**
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted afterwards; none is committed.
- **No Android device or emulator was used.**

### For Codex (found while building; none of it blocks this PR)

- **Transactions:** `PATCH /v1/transactions/:id` checks the date only by its shape (it takes 2026-02-30 and any future date) and does not check that tag ids exist. It lets the kind change on a linked transfer and on a split whole, and "excluded" on a split whole. Editing the amount of a cash transaction does not move the cash account's balance, though `POST /v1/cash` does.
- **Transfers:** confirming a suggestion (`activate` in `links.ts`) sets the link but leaves the transactions' `kind` as it was (read in the code, not run). The app sets the kind on screen when confirming, and a reload brings back the Worker's. There is no read that returns a transaction's suggestions; the app works them out from the dataset's links.
- **Cash accounts:** `POST /v1/accounts/cash` has no retry key, so a lost answer can lead to a second account. `isDefault: true` does not take the mark off another cash account in the same currency, after which `defaultCashAccount` picks either. The route accepts a negative balance, an untrimmed name and a name already in use.
- **Rates:** `POST /v1/fx/refresh` turns every failure into 0, so "no key" and "not reachable" look the same, and the counts include rates that were only written again.
- Unchanged from earlier entries: the items listed under blocks D and E and before.

### Not possible until Codex's routes exist (not built)

Block G (screens for the account editing routes) waits for Codex's contract to be merged. Also still waiting: entering a balance later for an account made as unknown; renaming or removing a hand-made account; cash deletion; category merging; export and backup in the app; the status panel; update notices; per-account history dates; attaching a provider account to an existing account; undoing an alert dismissal; deleting a stored file.

## 2026-11-14: Blocks G and H (account editing and removal, cash entry deletion, receipts to attach)

Started from `main` at `361327b` on `claude/keen-keller-u1th1y`, after checking on GitHub that PR #23 (F) and PR #24 (Codex's account editing and deletion routes) are merged. One pull request, one commit per block; this log entry is in the block H commit. Everything is built on routes in `backend/src/api/app.ts` on main and follows the "API contract for Claude" in Codex's entry "Item 2: unconnected account editing and removal (Claude G)". Changed: `apps/mobile/`, `packages/shared/src/api/index.ts` (additive types only) and this log. No backend, connector, workflow, root-config, dependency or lockfile changes.

### Shared types added (`packages/shared/src/api/index.ts`)

From the #24 contract, word for word in shape: `AccountDetailResponse` (GET and PATCH /v1/accounts/:id), `AccountPatchRequest`, `AccountDeletionBlocker`, `AccountDeletionCounts`, `DefaultCashAfterDeletion`, `AccountDeletionPreview`, `AccountDeleteRequest`, `AccountDeleteResponse`, `CashTransactionDeleteResponse`. For an existing route the app now uses: `ReceiptAttachResponse` (`{ receipt }`, POST /v1/receipts/:id/attach). The existing `AccountWithManualBalance`, `ManualCurrentBalance`, `ReceiptAttachRequest` and `TransactionResponse` are reused. Nothing renamed, removed or reshaped.

### Block G: account editing, removal and cash entry deletion

Account page (`features/accounts/AccountDetailScreen.tsx`):

- An account with a `connectionId` or an `externalId` shows why it is read-only, in plain words ("This account comes from your X connection, which keeps its name, kind and balance up to date..."), and offers nothing.
- Any other account gets "Edit" and "Remove", once the Worker's data is on screen. With sample data on screen it says to load the data (or set up the backend) first.

Editing (`accountEdit.ts`, `AccountEditSheet.tsx`, `actions.ts`):

- The form is filled from `GET /v1/accounts/:id`, not from the phone's copy, and keeps that answer's `version`.
- Name, kind, the balance now ("I know it" with an amount and the day it was true, or "Unknown") and "Count in net worth".
- PATCH sends `expectedVersion` plus only what changed. The Worker's answer replaces the phone's copy of the account, then the data is loaded again.
- Whenever the balance changes (amount, date, or known/unknown), the sheet says "You are changing the balance. Choose whether this balance counts in net worth." and the choice shown is always sent as `includeInNetWorth`, so the Worker never keeps an old switch by itself. Unknown turns the switch off and greys it.
- 409 `account_changed`: the account is read again. If the Worker already has the edit, it shows as saved. Otherwise the form shows the Worker's values with "This account was changed somewhere else after you opened it, so nothing was saved... Make your change again and tap Save." Nothing is resent.
- Timeout, network failure or 5xx: the account is read again before anything else, with the same two outcomes ("Your Worker's answer was lost, but it has your change." or "...it does not have your change, so nothing was saved"). If that read fails too, the sheet shows only "Check again"; Save is gone until a read works.
- 409 `account_connected` reads the account again and shows it read-only. 404 says the account is no longer on the Worker and reloads the data. Other refusals (`account_kind_conflict`, `invalid_body`) show the Worker's message.

Removing (`accountRemoval.ts`, `RemoveAccountSheet.tsx`):

- Opening "Remove" reads `GET /v1/accounts/:id/deletion-preview` and shows the Worker's account with its balance ("Unknown" for an unknown one).
- Blocked: "This account can't be removed yet." with every blocker, its count and what to do first. `account_not_empty` gives the number of transactions and says to undo the import or delete cash entries one at a time. `account_in_use` lists holdings, investment activities, recurring items, goals and rules by count and says switched-off rules and cancelled recurring items count. `import_in_progress` says to wait. `account_delete_too_large` gives the total against the 2,000 limit. `account_connected` says it can't be done here. Only "Check again" is offered.
- Allowed: what goes (the account, N saved balance readings, a hand-entered balance), what is detached (imports keep the file and history; saved layouts), and that categories, rules, statements and import history stay. A nonzero balance gets its own line. For cash, which wallet takes quick entries: "Quick cash entries in EUR go to this account now. After removal they go to "Euro B"." or that the next quick entry makes "Cash (EUR)".
- "Remove "name"" sends `DELETE` with the token of the preview on screen and nothing else. 409 `account_changed` or `account_delete_refused`: the new preview is shown with a notice and must be confirmed again; its token is never used by itself. A lost answer: `GET /v1/accounts/:id`; 404 means removed, otherwise the new preview is shown; if that read fails, only "Check again".
- After removal the account page says "Account removed" with where quick cash entries now go. The account and its balance readings leave the phone's data, the next wallet is marked as the default, and the data is loaded again.

Deleting a hand-entered cash entry (`transactions/cashDelete.ts`, `CashDeleteSection.tsx`, `actions.ts`, `TransactionDetailSheet.tsx`):

- Offered on a transaction's detail only when the contract allows: a cash account with no connection or provider id, `source: 'manual'`, no provider ids, no import id or fingerprint, not split, no transfer pointer and no link that is not rejected. That leaves out automatic ATM deposits (they carry `atm:` ids). A hand entry that is split or in a transfer (a suggested one counts) says what to undo first. Nothing is shown for other transactions or for sample data.
- Asks once, then waits for the Worker (nothing changes on screen first). The detail then reads, for example, "Deleted. The cash balance went back up by ₹1,240.00, to ₹4,690.00." from `reversedBalanceAmount` and the Worker's account. Zero says a balance was entered by hand after the entry; an unknown balance says it stays unknown.
- If the entry had a receipt: "Its receipt is kept and now waits to be attached to another transaction." with a "Receipts to attach" button (block H). The phone's copy of the receipt becomes `needs_review` with no transaction, as on the Worker.
- `cash_delete_refused`, `cash_balance_unknown` ("...Enter the cash account's balance first (Accounts, the cash account, Edit; known or unknown), then delete again."), `cash_balance_overflow` and `account_changed` are each said in plain words, with "Nothing was deleted". A lost answer: `GET /v1/transactions/:id`; 404 means deleted, otherwise "it was not deleted"; if that read fails, only "Check again".

Fixes found while building:

- `/transactions/<id>` swapped to "Transaction not found" the moment the entry was deleted, hiding the result. The route now keeps the last transaction it showed (`TransactionRoute.tsx`).
- A quick cash entry on a wallet whose balance is unknown no longer moves the 0 placeholder on the phone (`cash.ts`); the Worker keeps it unknown.
- The phone picks the quick-entry wallet as the Worker does: default first, else the oldest, then the lowest id, among cash accounts with no connection (`pickCashAccount`).
- The design system's `Switch` now also sets `aria-checked` and `aria-disabled`. The web build ignored `accessibilityState`, so its on/off state was invisible to screen readers in the browser.

### Block H: receipts that have no transaction

- `features/transactions/receiptInbox.ts`, `ReceiptsToAttachScreen.tsx`, route `src/app/transactions/receipts.tsx`.
- Where it is reached from (my choice): a "Receipts to attach · N" chip on Transactions, next to "Possible transfers", shown only when N is above 0 and the Worker's data is on screen; and the button after a cash entry with a receipt is deleted.
- The list comes from the dataset: receipts with no transaction or with status `needs_review`, newest first, leaving out photos still uploading from this phone (`pending-upload/` keys). Each row gives the shop, date, total and why it is waiting ("Has no transaction. Its old one was deleted, or the match was not clear." or "Attached, but your Worker was not sure...").
- Opening one shows its photo. The copy on this phone is used when there is one. Otherwise `GET /v1/receipts/:id/image` is read with the token, with `cache: 'no-store'`, into a `data:` URI held only in the view's state (`fetchImageData` in `data/backend/client.ts`, `ReceiptImage.tsx`). Nothing is written to the phone; the string goes when the view closes. A failure says so, with "Try again". It is not fetched while sample data is on screen. The same viewer now works from a transaction's receipt thumbnail when the photo is not on the phone.
- "Which purchase is it for?": money out, without another receipt, not split, not a linked transfer. The transaction an unsure match points at comes first, then the same amount in the same currency, then the fewest days apart. A search box narrows by name; 25 are shown.
- Picking one asks "Attach this receipt to "X" on <date>?", then sends `POST /v1/receipts/:id/attach` once and waits. The Worker's receipt goes into the phone's data and the transaction points at it. 409 `account_changed`: "That transaction was deleted while the receipt was being attached, so nothing was attached..." and the data is loaded again. 404 likewise. A lost answer: the data is loaded again and the receipt checked; it is either shown as attached or "was not attached. Pick the transaction again". Nothing is resent by itself.
- No "run now" buttons for AI jobs or the transfer matcher were added.

### Defaults chosen

- Balance dates are sent as noon UTC of the day typed, as the import form does, so the day reads the same in India and the US. Not after today, not before the opening balance date.
- A negative balance is allowed for every kind except cash (overdrawn, or a credit on a debt). Changing kind does not flip signs; the form says so.
- Unknown to known turns "Count in net worth" on, as making an account with a balance does; the sentence above the switch asks for the choice.
- The kind is locked for cash and for an account with holdings or investment activity on the phone (the Worker would refuse). All other kinds are offered, including crypto, property and vehicle.
- Edit and Remove are offered only with the Worker's data on screen. Provider accounts get no Remove (the preview would only say `account_connected`).
- Removal, cash deletion and attaching wait for the Worker; nothing changes on screen first. A second tap before the answer is ignored.
- Receipts list: newest first by when the Worker stored them.

### Validation

- `npm run check` passed: typecheck, lint, format and **1,301 tests** (shared 118, connectors 345, backend 313, deployment, runtime and recovery 46, mobile 479, up from 420). The block G commit on its own also passed typecheck, lint, format and the 465 mobile tests it has. ESLint needed `NODE_OPTIONS=--max-old-space-size=8192` in the cloud container; no config change.
- New mobile tests, all with invented data: `accounts/__tests__/accountEdit.test.ts` (13, form, checks and preview wording), `accountEditSheet.test.tsx` (9), `removeAccount.test.tsx` (8), `accountPage.test.tsx` (3), `transactions/__tests__/cashDelete.test.tsx` (12), `receiptInbox.test.ts` (6) and `receiptsToAttach.test.tsx` (8). The stand-in Worker in `data/backend/__tests__/helpers.ts` now records the fetch cache mode.
- Each new guard was removed once (a script swapped the line, ran the test file and put it back). All 65 made a test fail: block G 50 (including the route keeping the deletion result), block H 15. One had no test at first (a hand entry on a non-cash account); a test was added. The route fix came from the browser run and got its own test, which fails without it. The Switch's `aria-*` state cannot be seen in Jest (the native renderer folds it into `accessibilityState`); it is checked only in the browser run below.
- Exported web build against a local Worker (`wrangler dev --local`, throwaway `backend/.dev.vars`, `ALLOW_SAMPLE_SEED=true`, migrations 0001 to 0008, `POST /v1/dev/seed`, a fresh database for each run), at 412 px and 1280 px. Every result was read back from the Worker's own API. **39 of 39 checks passed at each width** (78 of 78), on the final build.
  - G: a connected account read-only with no Edit; rename sent as `{ expectedVersion, name: 'NRE Joint' }` and stored; set to unknown sent `{ currentBalance: null, includeInNetWorth: false }`, stored, shown as "Unknown" on the page and "Balance unknown" on Accounts; back to known with the switch offered on, sent with noon UTC of today and stored; a rename made through the API while the form was open gave the 409 notice with the Worker's name in the form, no second PATCH, then a deliberate save stored; a PATCH that reached the Worker but whose answer the browser dropped was shown as saved after one GET; a PATCH that never left showed the Worker's values and asked again; NRE's blocked preview showed both blockers and 7 transactions with no Remove button; an empty hand-made account (unknown balance) removed with one DELETE carrying the preview's token, 404 afterwards; a 409 on DELETE after a rename through the API showed the new name and removed only after a second tap; a default EUR wallet's preview named "Euro B", and after removal the Worker held Euro B as the default; deleting "Kirana store" said "went back up by ₹1,240.00, to ₹4,690.00" and the Worker's balance rose by exactly 124,000; a receipt uploaded and attached to "Pharmacy" was left `needs_review` with no transaction after deleting it, with the button shown; an entry whose amount was edited through the API got the `cash_balance_unknown` text and still existed; a linked ATM deposit offered no Delete.
  - H: the chip read "Receipts to attach · 2", the Worker's count; the list had exactly those 2; the uploaded photo was read from `GET /v1/receipts/:id/image` and drawn; attaching to the first candidate stored the match on the Worker both ways; afterwards localStorage, sessionStorage, Cache Storage and IndexedDB held nothing of the photo and no image was left on the page.
- **One answer was played by the browser:** the 409 `account_changed` from `POST /v1/receipts/:id/attach` (it needs a deletion inside the Worker's write). The message and the reload were checked; the Worker's receipt stayed unattached. Lost answers were made by the browser dropping the Worker's real answer.
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted afterwards; none is committed.
- **No Android device or emulator was used.**

### For Codex (found while building; none of it blocks this PR)

- **Receipt attach:** `attachReceipt` sets the target transaction's `receipt_id` even when it already has another receipt; that other receipt keeps `matchedTransactionId` pointing at it (read in `receipts/service.ts`, not run). The app does not offer such transactions. A 409 with a reason, or moving the old receipt to `needs_review`, would close it.
- **Receipt image:** `GET /v1/receipts/:id/image` answers `cache-control: private, max-age=3600`, so a browser may keep the photo for an hour. The app asks for `no-store`; `no-store` from the Worker would make it certain for every client.
- **Removal dead ends:** a recurring item (even cancelled), a goal or a holding blocks removal, and no route deletes them or moves them to another account (only `PATCH /v1/recurring/:id` with status exists). An account that ever had one cannot be removed.
- **Account PATCH:** a `currentBalance.asOf` in the future is accepted (only its format is checked; read in the code, not run). There is no way to change the opening balance, the subtype or which cash wallet is the default.
- **Cash deletion:** `cash_balance_unknown` asks for a new balance before an old edited entry can be deleted; that is a reset of the whole wallet's baseline for one entry. Unchanged from F: editing a cash amount does not move the balance.
- Unchanged from earlier entries: the items listed under blocks D, E and F and before.

### Not possible until Codex's routes exist (not built)

Category merging; export and backup in the app; the status panel; update notices; per-account history dates; attaching a provider account to an existing account; undoing an alert dismissal; deleting a stored file.

### How to test on the phone

Editing an account:

1. Accounts, tap an account you made by hand (not one from a bank connection), tap Edit.
2. Change the name, tap Save. "Saved." appears; close the sheet and the new name shows.
3. Edit again, tap "Unknown", tap Save. The page shows the balance as Unknown.
4. Edit again, tap "I know it", type today's balance, leave "Count in net worth" on, tap Save.
5. Open an account from a bank connection: it should say why it can't be edited, with no buttons.

Removing an account:

1. Open a hand-made account that has transactions and tap Remove. It should say it can't be removed yet and why.
2. Open an empty one (or make one in Import), tap Remove, read the list, tap Remove "name". The page says "Account removed".

Deleting a cash entry:

1. Add a quick cash expense, open it from Transactions, tap "Delete this cash entry", then Delete.
2. It should say how far the cash balance moved. Check the wallet's balance on Accounts.

Receipts to attach:

1. If Transactions shows "Receipts to attach · N", tap it.
2. Tap a receipt. Its photo loads (from your Worker if it is not on the phone).
3. Tap the purchase it belongs to, then Attach. Open that purchase: the receipt is on it.

## 2026-11-14: Blocks I, J and K (connect an assistant, matches after a receipt upload, unknown balances)

Started from `main` at `b2ab93c`. When this chat began, PR #25 (G and H) was still open with its apk build running; I checked GitHub again until it merged, then moved the branch onto `main`. One branch, one pull request, one commit per block. Every screen uses routes already in `backend/src/api/app.ts`: `POST /v1/mcp/clients`, `POST /v1/receipts`, `POST /v1/receipts/:id/attach` and `GET /v1/dataset`. Changed: `apps/mobile/`, `packages/shared/src/api/index.ts` (two additive types), `package-lock.json` (one new app dependency) and this log. No backend, connector, workflow or root-config changes.

### Shared types added

`McpClientRequest` (`{ name, redirectUris }`) and `McpClientResponse` (`{ clientId, clientSecret: string | null }`), exactly as `POST /v1/mcp/clients` reads and sends them. Nothing renamed, removed or reshaped.

### Block I: connecting an AI assistant

- `features/settings/sections/AssistantsSection.tsx` (new, one line in `SettingsScreen.tsx`, below AI): "AI assistants" with the MCP server address (the Worker URL plus `/mcp`), a copy button, and a "Connect an assistant" row. With no backend set it says the backend is needed.
- `features/assistants/ConnectAssistantScreen.tsx` (new) and route `src/app/assistants/index.tsx`: the server address again with a copy button and a line saying most assistants sign in by themselves; then a form for an assistant that asks for a client ID and secret: a name and 1 to 5 redirect addresses (add and remove rows).
- After `201`: the client ID and the secret, each with a copy button, and a warning: "This secret is shown only now and can't be shown again." If the Worker sends no secret, only the ID is shown and the screen says so. "Done, I've pasted them" takes both off the screen.
- The secret lives only in the screen's state. Nothing writes it to the device or logs it; it is gone on Done, when the screen closes (it is a pushed screen, not a tab, so closing unmounts it) and when the backend changes.
- Copying uses the new `expo-clipboard` dependency (installed with `expo install`, version 58.0.4 for SDK 58). The secret is copied marked sensitive, so Android 13 and later don't preview it. If copying fails, the screen says to press and hold the text, which is selectable.
- 503 `not_configured`: "Your Worker can't make assistant clients: its sign-in for assistants (OAuth) is not running, so nothing was made." A 4xx says nothing was made, with the Worker's reason. A lost answer, a timeout or a 5xx: "The answer from your Worker didn't arrive, so a client may have been made anyway. Nothing was sent again." The route has no retry key, so nothing is ever resent by itself; making another client is a deliberate tap. An answer that arrives after the backend changed is dropped and the screen says a client may exist on the previous backend.
- `features/assistants/mcpClient.ts` holds the checks and the error wording; `copy.ts` the clipboard call. A `copy` icon was added to the design system's icon list.

### Block J: matches right after a receipt upload

- `features/transactions/actions.ts`: `uploadReceiptForMatches` sends `POST /v1/receipts` without a transaction and waits for the answer (90 seconds), instead of the old fire-and-forget upload. The Worker's receipt goes into the app's data, and a purchase it matched points at it.
- `ReceiptMatches.tsx` (new) shows the answer:
  - Matched by the Worker: "Your Worker attached it to "Starbucks" on Nov 14." with its reason ("Same amount, same day.") and the amount, then "Not this one? Other likely purchases" when it sent others.
  - Not matched: "Likely purchases", best score first, each with the purchase, its date and account, the amount and the Worker's reason as a sentence, and an Attach button. One tap sends `POST /v1/receipts/:id/attach` once, then says "Attached to "name"."
  - None: why, from the receipt's status (AI off, could not be read, no total or date, or no purchase with that amount within 3 days), and that it waits in Receipts to attach.
- Attaching reuses H's `attachReceiptOnWorker` and `checkAttached`: 409 `account_changed` and 404 attach nothing and reload the data; a lost answer reloads and checks where the receipt is, with "Check again" if that fails. Nothing is resent by itself.
- A lost upload answer reloads the data. If exactly one new receipt arrived, it says the Worker stored it but its likely purchases were lost, and where the receipt is now. Otherwise it says it may still be being read and to look in Receipts to attach before sharing again. The upload is never resent by itself.
- Where it is used:
  - The Android share sheet: with your Worker's data on screen, "Keep without matching" becomes "Let my Worker find the purchase", and the sheet then shows the answer. With sample data the old local behaviour stays.
  - Receipts to attach: a new "Add a receipt photo" card (Take a photo and Choose a photo on the phone, Choose a photo on the web) that sends the photo and shows the answer in a sheet. This is also how a photo can be picked without a transaction.
- `receiptMatches.ts` (new): the pure view of the answer (matched one apart, the rest best first, no duplicates), the reason as a sentence and the "why none" wording.

### Block K: unknown balances added as 0

- `data/metrics.ts`: `countsInNetWorth` (switched in and the balance is known) is now the one rule for the net worth total and history. The new `netWorthByType` splits by kind with that same rule and lists accounts with an unknown balance.
- Net worth screen: the breakdown by kind used to add every account, including ones switched out of net worth and unknown ones. It now uses `netWorthByType`, so the kinds add up to the Assets and Liabilities totals above them. A line under the breakdown names the accounts left out for an unknown balance.
- Goals (`features/planning/goalStatus.ts`, new): a linked account with an unknown balance, with no exchange rate to the goal's currency, or no longer in the data is left out and named on the goal ("Leaves out "NRE Savings" (balance unknown)."). When every linked account is left out the goal shows "Unknown" and "Progress is not known", with no bar. Before, an unknown debt counted as 0 owed showed a debt goal as paid off.
- Planning: the retirement starting savings count only accounts that count in net worth.
- Accounts: group totals already left unknown balances out; each group now says which account its total leaves out.
- Searched every place the app adds balances. Nothing else adds an unknown balance; see "Remaining app work" for missing exchange rates.

### Defaults chosen

- Redirect addresses must be https, or http on localhost (the Worker accepts any URL). The same address twice is refused. Names are trimmed and 1 to 100 characters.
- The MCP address is built from the backend URL saved in the app, which is the Worker's `PUBLIC_URL` when deployed by the workflow.
- The secret screen is a pushed screen reached from Settings, so leaving it drops the secret.
- The upload answer is waited for up to 90 seconds, as the old upload did.
- The Worker's score decides the order but is not shown as a number; its reason is shown.
- Attaching a likely purchase is one tap with no confirmation, as asked. A second tap while one is on its way does nothing; after a lost answer the other Attach buttons stay off until "Check again".
- Closing the upload sheet while the photo is on its way drops the answer on screen; the receipt still lands in Receipts to attach.
- If the data on screen no longer has the receipt on the purchase the Worker matched, that purchase is offered again with the others.

### Validation

- `npm run check` passed: typecheck, lint, format and **1,350 tests** (shared 118, connectors 345, backend 313, deployment, runtime and recovery 46, mobile 528, up from 479). ESLint needed `NODE_OPTIONS=--max-old-space-size=8192` in the cloud container; no config change.
- 49 new mobile tests, all with invented data: `assistants/__tests__/connectAssistant.test.tsx` (19), `transactions/__tests__/receiptMatches.test.tsx` (18) and `networth/__tests__/unknownBalances.test.tsx` (12).
- Each of 48 new guards was removed once by a script, which ran its test file and put it back; every removal made a test fail (I 19, J 17, K 12). Five did not at first: the three double-tap tests tapped after a re-render (rewritten to tap twice inside one `act`, as the cash account test does), and the check for more than five addresses was hidden by the duplicate check (the test now uses six different addresses). Two J guards survived because the code was not needed: a second reload for a likely purchase not on the device (every upload already reloads) and a filter the dedupe already covers. Both were removed.
- Exported web build against a local Worker (`wrangler dev --local`, a throwaway `backend/.dev.vars`, `ALLOW_SAMPLE_SEED=true`, migrations 0001 to 0008, `POST /v1/dev/seed`, a fresh database per run), at 412 px and 1280 px. Every result was read back from the Worker's own API. **74 of 74 checks passed (37 at each width), on the final build.**
  - I: the address and its copy; an http redirect refused with nothing sent; one POST with exactly `{ name, redirectUris }`; the ID and secret on screen equal the Worker's answer. The Worker knows the client: `/authorize` shows its page for both redirects and refuses another. It accepts the shown secret (`/token` with a made-up code answers `invalid_grant`) and refuses a wrong one (`invalid_client`). Copy puts the ID and secret on the clipboard. The secret was not in localStorage, sessionStorage, IndexedDB, Cache Storage or the console. It was off the page after Done, and after leaving the screen and coming back.
  - J: a real upload stored with no transaction, and the real "could not be read" text. Likely purchases best first with the reason, then one tap attached on the Worker, with the receipt and the transaction pointing at each other. "Not this one" moved it to another purchase on the Worker. A 409 attached nothing and reloaded. A lost attach answer was checked and shown as attached, sent once. A lost upload answer found the stored receipt, sent once.
  - K, set up with the Worker's own PATCH: NRE Savings and Auto Loan unknown, NRO Savings switched out. Net worth named both unknown accounts; the Savings row showed $24,311, High-Yield Savings alone. Home in Hyderabad and Pay off the car showed Unknown with the reason, Emergency fund was unchanged, and both Accounts groups named what their totals leave out.
- **Played by the browser:**
  - The 503 `not_configured` answer: the local Worker runs the OAuth provider, so its real route made real clients.
  - The likely purchases and the Worker's own match in the upload answer: the local Worker can't run Workers AI, so it read no receipt and sent no candidates. Each upload still went to the Worker and stored a real receipt; only the answer's `match` and `candidates` were replaced. The match shown as "Your Worker attached it to" was not stored by the Worker.
  - The 409 from attach.
  - Lost answers: the request reached the Worker and the browser dropped the answer.
- Not checked in the browser: a backend change while the secret is on screen (Jest only).
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted afterwards; none is committed.
- **No Android device or emulator was used.** The share sheet, the camera, the Android clipboard's sensitive flag and the new native module in the APK are not checked here; CI builds the APK.

### For Codex (found while building; none of it blocks this PR)

- **MCP clients:** there is no read or delete for clients made by `POST /v1/mcp/clients`, and no retry key. After a lost answer an unused client stays in `OAUTH_KV` with no way to see or remove it from the app.
- **OAuth authorize:** `GET /authorize` with a redirect address the client did not register answers 500 (seen locally); a 400 would be clearer.
- **MCP `list_accounts`** sends an unknown balance as `amount(a.balance, ...)`, which is the placeholder 0 (read in `mcp/tools.ts`, not run). An assistant would read it as a zero balance. Sending null, or leaving such accounts' balance out, would match the app.
- **Receipts:**
  - `POST /v1/receipts` has no retry key, so a lost answer can only be worked out by looking for a new receipt.
  - The candidates and reasons are sent only in the upload answer; no read returns them later, so Receipts to attach can't show the Worker's reasons once the upload screen is closed.
  - With AI on but not reachable (as locally), the receipt is stored as `failed` with no way to ask the Worker to read it again.
- Unchanged from earlier entries: the items listed under blocks D to H and before.

### Remaining app work

- A balance in a currency with no exchange rate to the report currency is still counted as 0 in the net worth total, history and breakdown (`?? 0` after `convertAmount` in `data/metrics.ts`); goals now leave such accounts out. Showing those totals as incomplete needs a decision on what to show instead.
- `packages/shared/src/planning/recap.ts` (not mine to edit) adds snapshots of accounts in net worth; an unknown account can't be in net worth, so it is not affected today.

### Not possible until Codex's routes exist (not built)

Category merging; export and backup in the app; the status panel; update notices; per-account history dates; attaching a provider account to an existing account; undoing an alert dismissal; deleting a stored file; deleting goals or recurring items; deleting saved file layouts.

### How to test on the phone

Connecting an assistant:

1. Settings, AI assistants. The MCP server address ends in /mcp. Tap the copy button and paste it into Claude (Settings, Connectors, Add custom connector). Claude signs in by itself with your owner password.
2. Only if an assistant asks for a client ID and secret: tap "Connect an assistant", type its name, paste the redirect address it shows, tap "Make the client".
3. Copy the client ID and the secret into the assistant. The secret is shown once; tap "Done, I've pasted them" when finished.

A receipt with no transaction:

1. Share a receipt photo to Billionaire from the gallery, then tap "Let my Worker find the purchase". Or open Transactions, "Receipts to attach", and tap "Take a photo" or "Choose a photo".
2. Wait for "Sending the receipt to your Worker and reading it".
3. If your Worker matched it, it says which purchase. Otherwise tap Attach on the right likely purchase. Open that purchase: the receipt is on it.

Unknown balances:

1. Edit a hand-made account and set its balance to Unknown.
2. Net worth: the line under the breakdown names it, and the kinds add up to the totals.
3. Planning: a goal linked to it shows Unknown and says why.
4. Accounts: its group says the total leaves it out.

## 2026-11-14: Block L (accounts with no exchange rate)

Started from `main` at `7935548` (PR #26 merged), on the same branch name restarted from main. One commit. No route used beyond what the app already reads (`GET /v1/dataset`); in the browser test, `POST /v1/accounts/cash` and `POST /v1/accounts/manual` set up the accounts. Changed: `apps/mobile/` and this log only.

### What changed

The previous entry said a balance with no exchange rate is "counted as 0". Adding 0 leaves the account out of the number, so the totals were not wrong; they left an account out without saying so. This block names it wherever a total skips it, the same way block K does for unknown balances.

- `data/metrics.ts`: `accountsWithoutRate` (accounts whose balance has no latest rate to a currency). `currentNetWorth` and `netWorthByType` now also return `noRate`: accounts net worth would count (switched in, balance known) that add nothing for want of a rate. The numbers themselves are unchanged.
- `features/networth/leftOut.ts` (new): the wording, in one place.
- Net worth: a line under the breakdown, for example "Leaves out "Zurich wallet": there is no CHF to USD exchange rate yet, so it adds nothing. Refresh rates in Settings, Exchange rates." With several, it lists each name with its currency.
- Home: one line under the net worth for anything it leaves out, unknown balances included (one account by name; several as "Leaves out 2 accounts with an unknown balance or no exchange rate. See Net worth.").
- Planning: a line under "Starting from investment accounts" for an investment account with no rate to the planning currency.
- Accounts: a line under a group whose total leaves an account out for want of a rate. An account with an unknown balance gets only block K's line.
- Goals already left such accounts out (block K).

### Defaults chosen

- The rate checked is the latest one, as the totals use; the report currency is the one in the currency chip (the planning currency for Planning).
- An account switched out of net worth, or with an unknown balance, is never listed as missing a rate: it isn't counted anyway.
- The note says to refresh rates in Settings, Exchange rates; if the Worker's sources don't carry that currency at all, refreshing won't help, and the note does not claim it will.

### Validation

- `npm run check` passed: typecheck, lint, format and **1,360 tests** (shared 118, connectors 345, backend 313, deployment, runtime and recovery 46, mobile 538, up from 528). ESLint needed `NODE_OPTIONS=--max-old-space-size=8192`; no config change.
- 10 new mobile tests with invented data in `networth/__tests__/missingRates.test.tsx`.
- Each of 14 new guards was removed once by a script; every removal made a test fail. One had no test at first (an unknown balance in another currency on Accounts showing only the unknown line); the test was added.
- Exported web build against a local Worker (`wrangler dev --local`, throwaway `backend/.dev.vars`, `ALLOW_SAMPLE_SEED=true`, all migrations, `POST /v1/dev/seed`, a fresh database per run), at 412 px and 1280 px, with results read back from the Worker's API. **22 of 22 checks passed (11 at each width).** The Worker's rates covered USD, INR and EUR only. A CHF cash wallet and a GBP brokerage account were made on the Worker and stored as counted in net worth. Net worth then named both; its Assets total and Home's net worth stayed exactly as before; Home, Planning and the Cash and Investments groups each named the right account.
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted; none is committed.
- **No Android device or emulator was used.**

### Remaining app work

- Spending and budget totals (`display.total`, by each transaction's day rate) also add nothing for a transaction with no rate, without saying so. That is a different number (spending, not balances) and is not changed here.

### How to test on the phone

1. Accounts, Connectors tab, "Add a cash account" in a currency your Worker has no rate for (for example CHF), with some cash on hand.
2. Net worth: the line under the breakdown names it and says there is no rate. The total does not change.
3. Home: the line under the net worth names it.
4. Accounts: the Cash group says its total leaves it out.
5. Settings, Exchange rates, "Refresh rates now". If a rate arrives, the lines go away and the account is counted.

## 2026-11-14: Block M (spending totals with no exchange rate)

Started from `main` at `b984339` (PR #27 merged), on the same branch name restarted from main. One commit. Changed: `apps/mobile/` and this log only. In the browser test, `POST /v1/accounts/cash`, `POST /v1/cash` and `PUT /v1/budgets` set up the data.

### What changed

`summarizeSpending` (shared) skips a transaction no rate converts and only counts it (`missingRate`); no screen showed that count, and some screens sum on their own. A "day rate" lookup falls back to the nearest rate the Worker has, so a transaction is skipped only when its currency has no rate to the report currency at all, the same case as block L.

- `data/metrics.ts`: `transactionsWithoutRate` lists the transactions a spending or income total in a currency skips, with the same rule as `summarizeSpending` (in the date range, counted by `reportTreatment`, no rate); a test checks the count equals `missingRate`. `monthSpending` also returns `noRate` for this month.
- `features/currency/missingRates.ts` (new): the wording. One transaction is named with its amount and date ("Leaves out "Migros" (CHF 42.50, Nov 14): there is no CHF to USD exchange rate yet. Refresh rates in Settings, Exchange rates."); several are counted with up to three names.
- Home: a line on the spending card (the budget card covers the same month).
- Budgets: a line under the month for its skipped transactions (it applies to the Budget and Spending plan views), and a line for a budget set in a currency with no rate, which the shared budget math counts as a 0 budget ("The "Fees" budget is in CHF, and there is no CHF to USD exchange rate yet, so it counts as 0 here.").
- Recaps: a line under "Spent" for the period shown.
- Recurring: a line under "Bills and subscriptions per month" for an active bill or subscription with no rate; the monthly and next-30-days totals leave it out.
- Transactions table (Compact look, wide screens): the footer says how many selected rows the selected total leaves out ("301 selected. 1 is not in the total: no exchange rate to USD.").
- Numbers are unchanged.

### Defaults chosen

- The currency checked is the report currency in the chip; in Both mode the line speaks of the main one.
- Only transactions that count in reports are listed (transfers, card payments, split wholes and excluded rows are not).
- A recap stored by the Worker gets the same line, worked out on the phone from the same data and rates.
- Income items on Recurring are not listed: the totals there are bills and subscriptions.

### Validation

- `npm run check` passed: typecheck, lint, format and **1,368 tests** (shared 118, connectors 345, backend 313, deployment, runtime and recovery 46, mobile 546, up from 538). ESLint needed `NODE_OPTIONS=--max-old-space-size=8192`; no config change.
- 8 new mobile tests with invented data in `currency/__tests__/missingRates.test.tsx`, including one that checks the list matches `summarizeSpending`'s `missingRate`.
- Each of 18 new guards was removed once by a script; every removal made a test fail. Two had no test at first (the end of the date range, and the table counting only selected rows); tests were added. A check for future months on Budgets was removed as unneeded (the date range is already empty).
- Exported web build against a local Worker (`wrangler dev --local`, throwaway `backend/.dev.vars`, `ALLOW_SAMPLE_SEED=true`, all migrations, `POST /v1/dev/seed`, a fresh database per run), with results read back from the Worker's API. **17 of 17 checks passed** (8 at 412 px; 9 at 1280 px, where the Compact table also shows). The Worker had no CHF rate. A CHF cash wallet, a CHF 42.50 cash expense and a CHF budget were stored on the Worker. Home, Budgets and the monthly recap then named the expense with its amount and date, Home's spending total stayed exactly the same ($3,909.11), Budgets said the CHF budget counts as 0, and the table's footer said one selected row was not in the total.
- Recurring was checked in Jest only: no route makes a recurring item in another currency.
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted; none is committed.
- **No Android device or emulator was used.**

### Remaining app work

- The Spending plan's savings figure and its bills list convert with the latest rate and add nothing for a currency with no rate, without a line of their own (the Budgets line above covers the month's transactions only).
- Investments (holdings value, cost and gains) also add nothing for a holding with no rate; not changed here.

### How to test on the phone

1. Make a cash account in a currency your Worker has no rate for (Accounts, Connectors tab, "Add a cash account", for example CHF), then add a quick cash expense in it.
2. Home: the spending card names the expense, and the total doesn't change.
3. Budgets and Month in review: the same line.
4. Settings, Exchange rates, "Refresh rates now". If a CHF rate arrives, the lines go away and the expense is counted.

## 2026-11-14: Blocks N, O and P (linking after Codex's #28, the last missing-rate totals, saved file layouts)

Started from `main` at `f5b54ae`. GitHub shows PRs #26, #27, #28 (Codex's, head `03436ad`) and #29 merged; main did not move during the work. One branch (`claude/gracious-mccarthy-icwche`), one pull request, one commit per block. Every screen uses routes already in `backend/src/api/`: `/v1/link/sophtron/*`, `/v1/link/snaptrade/*`, `GET /v1/dataset`, `POST /v1/connections/:id/sync` and `GET /v1/import-mappings`. Changed: `apps/mobile/`, `packages/shared/src/api/index.ts` (two additive types) and this log. No backend, connector, workflow, root-config, dependency or lockfile changes.

### Shared types added

`ImportMapping` (`{ signature, name, accountId: Id | null, mapping: CsvMapping, updatedAt }`) and `ImportMappingsResponse` (`{ mappings }`), exactly as `GET /v1/import-mappings` sends them. Nothing renamed, removed or reshaped. The link types already matched Codex's contract, so they were not touched.

### Block N: Sophtron and SnapTrade linking (app side of findings 10 and 11)

Built from the "API contract for Claude" in codex-log, "Item 3: recoverable Sophtron completion and verified SnapTrade repair".

Sophtron (`features/link/sophtronPoll.ts`, `SophtronFlow.tsx`):

- The linkId from start is kept for the whole sign-in and every later request is about it. Status requests stay one at a time with the 3-second pause. A timeout, no answer or a 5xx asks the same linkId again (three in a row stop with Check again, as before). A 429 waits 15 seconds before the same question and is not counted as a failure.
- A "done" answer goes on to the existing sync step only when it names the connection and says `repaired`. A repair must name the connection being repaired with `repaired: true`; a new login must say `repaired: false`. Anything else is treated as unconfirmed. The old reload-and-guess fallback from PR A (#17) is removed: the app no longer infers a new connection from the data.
- 409 `link_result_unavailable` (on start or status), or a done without its connection: the screen says "Your Worker can't confirm how this sign-in ended, so the app has not linked anything and has not started another sign-in", reloads Accounts and says what to look for there. Start over appears only after the reload worked, and is your own tap. If the reload fails, a Reload Accounts button comes first.
- Start whose answer was lost (no answer, timeout, 5xx or 429): nothing is sent again; the same screen says a sign-in may have started at the bank anyway and reloads Accounts.
- A 404 on status ends the sign-in, back to the start with the Worker's message.
- MFA: an answer refused outright (400, 401) stays on the question with the reason. Any other failure (no answer, 5xx, 429, or 404 racing completion) hides the question, says the answer may or may not have reached the bank, and asks the status of the same linkId before anything else; after a 429 it waits 15 seconds first. Only one answer is ever on its way (two quick taps send one), and nothing is answered once the status says done.

SnapTrade repair (`features/link/BrowserFlow.tsx`):

- 200 with `repaired: true` naming this connection is a finished repair and goes to the sync step. An answer that does not name this connection as repaired is not taken as a repair (reload and say so).
- 409 `repair_not_finished`: "SnapTrade has not finished the reconnect yet, so nothing was changed. Finish reconnecting your brokerage in SnapTrade (open it again if you closed it), then tap Check again." Check again sends complete on the same linkId, on your tap.
- 409 `connection_changed`: reloads Accounts, says the repair was not saved and to start a new repair if it still needs one. The linkId is dropped: no Check again, no Done.
- No answer, timeout or 500: Accounts is reloaded first. If it shows the connection working again (healthy or syncing), the repair was saved and the sync step follows, with no second complete. If it still needs repair, Check again is offered. If the reload fails, only Reload Accounts is offered.
- 404 (attempt over): reload; a saved repair goes on to the sync step, otherwise "This SnapTrade attempt has ended" with no retry.
- 502 and 429: the Worker's message, and Check again (SnapTrade failed, nothing was saved). 503: the message only.
- Kept from #17: a closed or cancelled window on the phone completes nothing; a repair offers no "I finished" after a cancel; the web's Done is your own tap; the sync after a repair is still the proof.

### Block O: the last totals that leave out an amount with no exchange rate

Numbers are unchanged; each total now names what it leaves out, with the wording in `features/currency/missingRates.ts` (`skippedItemsText` takes an optional noun; new `savingsNoRateText` and `billNoRateText`).

- Spending plan (`features/budgets/SpendingPlanView.tsx`): a line under the totals for active bills, subscriptions and income items with no rate ("Leaves out "Xfinity internet" (CHF): there is no CHF to USD exchange rate yet..."); a line when savings is set in a currency with no rate ("Savings is set in CHF, and there is no CHF to USD exchange rate yet, so it counts as 0 here..."); and on each such bill's row: "No CHF to USD rate yet, so it is not in the plan". The month's transactions were already named by block M's line on Budgets.
- Investments (`features/networth/InvestmentsScreen.tsx`): "Value, cost and gains: Leaves out ..." under the Invested total (also covers the allocation chart), "Realized gains: ..." under the realized total (follows the year chosen), "Dividends: ..." under the dividends, each named by symbol once. A position's lot sheet says when its report-currency amounts show 0 for want of a rate.

### Block P: saved file layouts

- Import screen: a third tab, "File layouts" (`features/import/SavedLayouts.tsx`), reads `GET /v1/import-mappings`. Each layout shows its name (the file that first saved it), where its rows went ("Into "Everyday Checking"", "No account saved with it", or "Into an account not on this device"), "Last used" with the day, and the columns it reads (date order, one amount column or two, lines skipped). Newest first, as the Worker sends them.
- Read-only. It says removing one is not possible from the app yet. Empty, loading and error states, with Try again. A backend change loads the list again; an answer or error for the previous request is dropped.

### Defaults chosen

- The wait after a 429 is 15 seconds; the Worker sends no Retry-After the app could read.
- A lost or 429 Sophtron start counts as "may have started" (a 429 can come from the provider poll inside start, after the login was created).
- A Sophtron "done" without a valid connection and flag is never guessed from the data, even when a new connection appears there.
- For SnapTrade, a connection showing healthy or syncing after a reload counts as repaired, because Codex's repair commit sets `syncing` and clears the error; the sync step that follows is still the proof shown.
- New SnapTrade links get the same reload-before-retry after a lost answer, so a brokerage is not linked twice.
- Block O lines speak of the report currency in the chip (the main one in Both mode), as in blocks L and M. Savings of 0 and paused items get no line.
- File layouts live in the import flow, not Settings: that is where they are used, and Settings has no import section.

### Validation

- `npm run check` passed before the push: typecheck, lint, format and **1,447 tests** (shared 118, connectors 346, backend 345, deployment, runtime and recovery 46, mobile 592, up from 546). ESLint needed `NODE_OPTIONS=--max-old-space-size=8192`; no config change.
- New mobile tests, all invented data: `link/__tests__/linkRecovery.test.tsx` (34), `currency/__tests__/planInvestmentsNoRate.test.tsx` (12), `import/__tests__/savedLayouts.test.tsx` (7). `linkSafety.test.tsx` lost the seven tests of the removed guessing fallback; its done answers now carry `repaired`.
- Each of 60 new guards was removed once by a script that ran the tests and put it back; every removal made a test fail (N 30, O 20, P 10). Three survived at first and got tests: a done with an empty ID list, Done hidden on the web while Accounts must be reloaded, and an error from a previous backend's list. Two P guards were unreachable (an old backend's list never arrives because `api()` drops it as superseded) and were removed.
- Exported web build against a local Worker (`wrangler dev --local`, throwaway `backend/.dev.vars` with `ALLOW_SAMPLE_SEED=true` and an invented `CREDENTIALS_SECRET`, migrations 0001 to 0009, `POST /v1/dev/seed`, a fresh database per width), at 412 px and 1280 px. **60 of 60 checks passed (30 at each width).** The first run at 412 px had 3 failures, all in the test script (it read the sync headline after the sync had already ended, used a check that does not wait, and expected 200 where the Worker answers a new import preview with 201); fixed and rerun on fresh databases.
  - N, real Worker: Sophtron institutions and SnapTrade start both answered 503 `not_configured` (no provider keys). For SnapTrade the screen showed the Worker's message; for Sophtron the check confirmed the 503 only.
  - N, played: status answered 500, 429, then done. One start; three status requests, all for the same linkId, never two at once; the next request came 4.5 s after the 500 (1.5 s answer plus the 3 s pause) and 15.4 s after the 429. The real sync then ran on the named connection and showed "The repair is not confirmed" (the Worker has no Sophtron keys; its status stayed `needs_repair`).
  - N, played: 409 `link_result_unavailable` reloaded Accounts from the Worker and showed the plain words; start once, status once, nothing more in 7 s. A lost start: sent once, no status request. MFA: after a lost answer the same linkId was asked before the next question; two answers in all, none after done.
  - N, SnapTrade, played complete answers: `repair_not_finished`, then Check again on the same linkId and a 200 repair went to the real sync. `connection_changed` reloaded Accounts and offered no retry. A lost answer with the connection set to `needs_repair` in the local database: reloaded, "still needs repair", sent once; Check again then got a played 404 and offered nothing more. A lost answer with the connection healthy on the Worker: straight to the real sync, no second complete.
  - O: in the local database, the Xfinity bill, VTI's holding, lots and activities were set to CHF; the Worker's own dataset showed them in CHF with no CHF rate. Spending plan, Investments and the VTI lot sheet showed every line above. The CHF savings came from the browser's own settings (planning is a device setting, not stored on the Worker).
  - P: the tab showed "No saved layouts yet" while the Worker had none. A real CSV import through the Worker (preview 201, commit 200) saved one layout; the tab then showed its name, "Into "Everyday Checking"" (the Worker's `accountId`) and "Last used Nov 14" (its `updatedAt`).
- **Played in the browser:** every `/v1/link/sophtron/*` and `/v1/link/snaptrade/*` answer except the two real 503s. No provider was called and no real credential was used (the sign-in fields held "demo-user" and "demo-password").
- `backend/.dev.vars`, `backend/.wrangler` and the web export were deleted; none is committed.
- **No Android device or emulator was used.** The phone-only browser paths (Custom Tab closed, cancelled, `status=ok`) are covered by Jest with a stand-in browser.

### For Codex (found while building; none of it blocks this PR)

- **Saved file layouts:** no route deletes one (for example `DELETE /v1/import-mappings/:signature`). The layout's name stays the first file's name; later imports update only the mapping, account and time.
- **SnapTrade complete:** no replay. After a lost answer the app can only read Accounts; replaying a committed repair's answer, as Sophtron status now does, would remove that step.
- **Sophtron start and MFA answers:** no retry key. A lost start leaves a sign-in the app can't find again; a key the app sends would let it recover the linkId.
- **429:** no Retry-After on the Worker's answer; the app waits a fixed 15 seconds.
- **Web SnapTrade:** still no status the app could read for a browser session, so the web build can't tell a finished login from a closed tab.
- Unchanged from earlier entries: the items listed under blocks D to K and before.

### Remaining app work

- The S&P 500 comparison on Investments was not checked for a currency with no rate.

### Not possible until Codex's routes exist (not built)

Category merging; export and backup in the app; the status panel; update notices; per-account history dates; attaching a provider account to an existing account; undoing an alert dismissal; deleting a stored file; deleting goals or recurring items; deleting saved file layouts; listing or deleting MCP clients; reading a receipt's candidates after the upload.

### How to test on the phone

Sophtron:

1. Accounts, a Sophtron connection that needs repair, Repair, "Answer the bank's question".
2. Turn on airplane mode for a few seconds while it says "Signing in". It keeps asking about the same sign-in and never starts a second one.
3. If it says "Not confirmed", open Accounts and look for the bank before tapping Start over.

SnapTrade repair:

1. Accounts, a SnapTrade connection that needs repair, Repair, Open SnapTrade.
2. Close SnapTrade before finishing. The app says nothing was changed and offers only Open SnapTrade.
3. Open it again and finish. If the app says SnapTrade has not finished the reconnect, finish it there and tap Check again. "Repaired and synced" appears only after the sync works.

Missing rates:

1. Make a bill or subscription in a currency your Worker has no rate for, or hold an investment in one.
2. Budgets, Spending plan: a line under the totals names it, and its row says it is not in the plan.
3. Net worth, Investments: lines under Invested, Realized gains and Dividends name it.

Saved file layouts:

1. Import a bank CSV (Accounts, Import a statement) and save it.
2. Tap the "File layouts" tab: the file's layout is listed with its account and today's date.
