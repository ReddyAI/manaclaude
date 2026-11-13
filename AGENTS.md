# Agent instructions

- Read [CLAUDE.md](CLAUDE.md) first and follow it; it is the rulebook.
- Then read `docs/handoff/codex-log.md` and `docs/handoff/claude-log.md`, in that order, at the start of every task. Read every Claude section headed "For Codex", "What Codex needs to do" and "Still needed from Codex for findings 10 and 11" as backend requests. Never edit Claude's log.
- Use Node 24 and npm 11. npm 10 crashes on this workspace.
- Set `EXPO_OFFLINE=1` for Expo commands.
- Start each task from the latest `main`, work on your own branch, and open a PR. Never push to `main` or merge a PR.
- `npm run check` must pass before every push.
- Codex owns `backend/` and `connectors/`; Claude owns `apps/mobile/`. Changes to `packages/shared/`, root configuration, or `.github/workflows/` need explicit authorization, apart from this file and `docs/handoff/`.
- Never call Plaid, including its Sandbox, or change `PLAID_LINK_ENABLED`. Existing tests use invented responses only.
- Never change how `CREDENTIALS_SECRET` is used. Never commit secrets or personal data.
- After every task, append to `docs/handoff/codex-log.md`; do not edit Claude's log.
