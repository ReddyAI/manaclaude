# CLAUDE.md

Read this first in every session. The full brief is [docs/project-brief.md](docs/project-brief.md) and the requirements addendum is [docs/requirements-addendum.md](docs/requirements-addendum.md). Both are Sankar's words, saved unchanged; don't edit them.

## The project in short

A personal finance app for Sankar's own use. Claude writes all the code; Sankar says what he wants and does not code.

- Platforms, in order: Android (Oppo Find X9 Pro), web/desktop, iOS.
- App: Expo SDK 58 (React Native 0.88) + TypeScript, Expo Router, one codebase.
- Backend: Cloudflare Workers (free plan) + D1 + Cron Triggers, R2 for receipts and statements, Workers AI.
- Builds: GitHub Actions makes the Android APK and the web build.
- Personal accounts only. Connectors that need a business account are listed as unavailable.
- Money: USD and INR. NRE/NRO accounts in India, US banks, cards and brokerages, Zerodha, crypto.
- Sure (AGPL-3.0, github.com/we-promise/sure) is the reference for connectors and the data model. Port logic, don't fork. This repo is AGPL-3.0 too.
- No .NET, no Flutter.

## Rules for every session

1. **The repo is public.** Never commit secrets, API keys, tokens, personal data or real account details. Sample data uses invented names and numbers. Secrets go in Worker secrets or a git-ignored `.dev.vars`.
2. **research/ is read-only** for build sessions. It belongs to the research session. Never edit, move or reformat anything in it (Prettier and ESLint already skip it).
3. **Edit only your own folders** (table below). The shared model and the shared app folders change only through small, additive edits: add a field, a type, a file or a component; don't rename, remove or reshape what others use. If a type you need already exists, reuse it.
4. **Work on your own branch and open a pull request to main.** Run `npm run check` before every push; it must pass.
5. Pick sensible defaults instead of stopping to ask, and list them in your pull request.

## Folder layout and owners

```
apps/mobile/                 Expo app (Android, web, iOS)
  src/app/                   Expo Router routes: thin files that re-export screens
  src/design/                design system: tokens, themes, haptics, components
  src/data/                  data store, settings store, shared metrics
  src/navigation/            tab bar (phone) and sidebar (wide screens)
  src/features/<area>/       one folder per screen area
packages/shared/             @manaclaude/shared: data model, money, policies, FX, lots, sample data
backend/                     @manaclaude/backend: Cloudflare Worker + D1
connectors/                  @manaclaude/connectors: registry and one adapter per provider
docs/                        brief, addendum, plans, session prompts
research/                    research session only
```

| Owner                                                                  | Paths                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: Dashboard, Transactions, Accounts                                   | `apps/mobile/src/features/{dashboard,transactions,accounts}/`, `features/currency/CurrencyChip.tsx`, `features/settings/sections/DisplaySection.tsx`, new routes under `src/app/{transactions,accounts,dashboard}/`, `packages/shared/src/sample/transactions.ts`                                                                                             |
| B: Backend, imports, AI, MCP                                           | `backend/`, `packages/shared/src/{fx,policy,api,import}/`, `features/settings/sections/{AiSection,MoneyPoliciesSection}.tsx`, `docs/backend-plan.md`, `docs/mcp.md`                                                                                                                                                                                           |
| C: Budgets, recurring, net worth, investments, recaps, USD/INR display | `apps/mobile/src/features/{budgets,recurring,networth,planning,recaps}/`, `features/currency/{useMoneyDisplay.ts,Amount.tsx}`, `features/settings/sections/BudgetsSection.tsx`, new routes under `src/app/{budgets,recurring,networth,planning,recaps}/`, `packages/shared/src/investments/`, `packages/shared/src/sample/{budgets,recurring,investments}.ts` |
| D: Connectors                                                          | `connectors/` (registry, adapters, pure sync merge logic in `src/sync/`, slot tracking, fixtures), `packages/shared/src/sample/accounts.ts` (sample connections)                                                                                                                                                                                              |
| Shared (additive only)                                                 | `packages/shared/src/{model,money,dates}/`, `packages/shared/src/sample/index.ts`, `apps/mobile/src/{design,data,navigation}/`, `apps/mobile/src/app/_layout.tsx`, `src/app/(tabs)/`, `features/settings/SettingsScreen.tsx` (one import line per new section), root config files, `.github/workflows/` (add new files; B adds the Worker deploy)             |

New screens: add a route file under `src/app/<area>/` (for example `src/app/transactions/[id].tsx`) that re-exports a screen from your feature folder. The root Stack picks it up; no layout edit needed. New settings: add a file in `features/settings/sections/` and one line in `SettingsScreen.tsx`.

## Coding conventions

- **Money** is an integer count of minor units plus an ISO currency code (`amount: 1234, currency: 'USD'` is $12.34). Never floats. Format with `formatMoney`, show with `MoneyText` or `Amount`.
- **Sign rule:** a transaction's `amount` is negative when money leaves the account and positive when it arrives, for every account type including credit cards. Connectors convert provider signs to this.
- **Dates** are `"YYYY-MM-DD"` strings (`LocalDate`); timestamps are ISO UTC. Use the helpers in `packages/shared/src/dates`.
- **Spending and income** always go through `reportTreatment` / `summarizeSpending` in `packages/shared/src/policy`. Never re-implement which transactions count; that is how transfers and card payments stay out of spending.
- **Currency display** goes through `useMoneyDisplay` / `Amount`. Balances use the latest rate; transactions pass their `date` so reports use that day's rate.
- **Styles** use Unistyles: `StyleSheet.create((theme, rt) => ({ ... }))`. Screens never hard-code colours or sizes; ESLint blocks hex/rgb literals and numeric spacing, size, radius and font values in `src/features/` and `src/app/`. Use `theme.colors`, `theme.space`, `theme.size`, `theme.radius`, `theme.type`, `theme.motion`.
- **Components:** import from `src/design/components/<File>` by path (no barrel file). Icons through `Icon` (Lucide set, never another app's icons), haptics through `haptic()`, long lists through FlashList.
- **Data in the app:** read with `useFinance()` / `useFinanceSelector()`, write with `updateFinance()` from your feature's own `actions.ts`. Settings through `useSettings()` / `updateSettings()`.
- TypeScript strict with `noUncheckedIndexedAccess`. Prettier (single quotes, width 100) and ESLint run in CI.
- Tests: Vitest in `packages/shared`, `connectors` and `backend` (`test/*.test.ts`); Jest (jest-expo) in the app (`src/**/__tests__/*.test.tsx`). Testing Library v14: `render`, `act` and `fireEvent` are async, so `await` them.

## Commands

Node 24 and npm 11 (npm 10 crashes while resolving this workspace). The cloud container defaults to Node 22, so run `export PATH=/opt/node24/bin:$PATH` first. Run Expo CLI with `EXPO_OFFLINE=1` here because api.expo.dev is blocked.

```bash
npm ci                                  # install everything
npm run check                           # typecheck + lint + format check + all tests
npm run format                          # fix formatting
npm test -w @manaclaude/shared          # one package's tests
cd apps/mobile && EXPO_OFFLINE=1 npx expo start --web     # run the app in a browser
cd apps/mobile && EXPO_OFFLINE=1 npx expo export --platform web --output-dir dist
cd backend && npx wrangler dev          # run the Worker locally
```

Adding a dependency: add it to your own workspace only, `npm install <pkg> -w <workspace>`. For a native module in the app use `cd apps/mobile && EXPO_OFFLINE=1 npx expo install <pkg>` so the version matches SDK 58. If `package-lock.json` conflicts after a rebase, take main's copy and run `npm install` again.

## More docs

- [docs/data-model.md](docs/data-model.md): entities, sign rules, transfers, splits, user edits
- [docs/design-system.md](docs/design-system.md): looks, tokens, components, haptics
- [docs/backend-plan.md](docs/backend-plan.md): backend plan with the five build checks as test cases
- [docs/setup.md](docs/setup.md): one-time Cloudflare and GitHub secrets setup, provider keys, Zerodha redirect URL
- [docs/parallel-sessions.md](docs/parallel-sessions.md): prompts for sessions A to D
