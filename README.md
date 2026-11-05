# Mana

A personal finance app for one person's own accounts: US banks, cards and brokerages, Indian NRE/NRO accounts and investments, crypto, and cash in USD and INR. Android first, then web, then iOS.

Everything here is built by Claude in Claude Code cloud sessions. Start with [CLAUDE.md](CLAUDE.md) for the layout and rules, [docs/project-brief.md](docs/project-brief.md) for what the app should do.

## Get the Android app

Every push to a pull request that touches the app runs the **Android APK** workflow. Open the run under the repo's Actions tab, scroll to **Artifacts** and download `mana-android-apk`. Unzip it and install the `.apk` on the phone (allow installs from your browser or file manager when Android asks). New builds install over old ones.

The web build is the `mana-web` artifact of the **Web build** workflow: a static site you can open with any static file server.

## Develop

Needs Node 24 and npm 11.

```bash
npm ci
npm run check
```

```bash
cd apps/mobile && npx expo start --web
```

Right now the app runs on made-up sample data. The backend (Cloudflare Worker), file imports and connectors come next, built in parallel by four sessions; see [docs/parallel-sessions.md](docs/parallel-sessions.md).

## Licence

AGPL-3.0-or-later (see [LICENSE](LICENSE)), so logic can be ported from Sure, which uses the same licence.
