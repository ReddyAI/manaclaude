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
