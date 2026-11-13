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
