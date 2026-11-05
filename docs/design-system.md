# Design system

Code: `apps/mobile/src/design/`. Every component reads its colours, type, spacing, corner radius, motion and haptic strength from the active Unistyles theme, so switching the look restyles the whole app at runtime (CSS variables on web).

## Looks

Three looks, each with light and dark, give six themes (`themes.ts`). The user picks the look and light/dark/system in Settings > Appearance.

| Look     | Inspired by | What changes                                                                                                                                                            |
| -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Midnight | Copilot     | Near-black navy canvas `#000814`, text at 90% white, large display numbers (46 px hero), charts first, flat cards in dark mode                                          |
| Warm     | Monarch     | Cream and brown palette, orange accent, card widgets with soft shadows                                                                                                  |
| Compact  | Lunch Money | 13 px body text, 44 px rows, tighter spacing, small radii, outlined cards, spreadsheet transactions table on wide screens with resizable columns and bulk-select totals |

All looks use green for income, red for spending, blue for net worth and yellow for pending (`theme.colors.income`, `spending`, `netWorth`, `pending`).

## Tokens (`tokens.ts`)

- `colors`: canvas, surfaces, borders, text levels, accent, the four money colours with muted variants, chart colours, tab bar, 12 category slots plus `categoryMuted` tints.
- `type`: display, title, headline, body, bodyStrong, label, caption, micro, amountHero, amountLarge, amount, amountSmall. All Inter (400/500/600/700).
- `space`, `radius`, `size` (icons, avatars, rows, buttons, inputs, tab bar, sidebar, charts, switches), `motion` (fast, normal, slow, spring, press scale), `haptics` (scrub ticks on/off, iOS impact strength), `layout` (card style, dense tables, chart-first).

Add a token instead of a number. ESLint fails on hex/rgb literals and numeric sizes inside `src/features/` and `src/app/`.

## Components (`components/`)

| File                 | Exports                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Text.tsx`           | `Text` with `variant`, `tone`, `numeric` (tabular figures)                                                        |
| `MoneyText.tsx`      | `MoneyText`: integer minor units, always tabular figures, `colorize` flow/signed                                  |
| `Icon.tsx`           | `Icon` (Lucide icons by name, category icon keys included)                                                        |
| `Card.tsx`           | `Card` (raised, flat or outlined per look; optional `onPress`)                                                    |
| `ListRow.tsx`        | `ListRow` (leading, title, subtitle, trailing, chevron, dimmed)                                                   |
| `Button.tsx`         | `Button` (primary, secondary, ghost, danger; sm/md/lg), `IconButton`                                              |
| `Controls.tsx`       | `Switch` (toggle haptics), `SegmentedControl`, `Chip`, `Badge`, `Dot`, `ProgressBar` (with marker), `TextField`   |
| `BottomSheet.tsx`    | `BottomSheet` (drag to close; centred dialog on wide screens)                                                     |
| `Layout.tsx`         | `VStack`, `HStack`, `Spacer`, `Divider`                                                                           |
| `Decor.tsx`          | `Avatar` (initials, never logos), `IconBadge`, `SectionHeader`, `EmptyState`, `Banner`                            |
| `Screen.tsx`         | `Screen` (safe area, large title, header actions, max content width)                                              |
| `PressableScale.tsx` | Press-to-shrink wrapper used by tappable components                                                               |
| `charts/Charts.tsx`  | `LineChart` (area, comparison series, scrubbing with Segment_Tick haptics), `Sparkline`, `BarChart`, `DonutChart` |

Feature-level building blocks used by several screens: `features/currency/Amount.tsx` (follows the display currency) and `features/currency/CurrencyChip.tsx`.

## Haptics (`haptics.ts`)

Call `haptic(event)`; never call expo-haptics directly.

| Event                            | Android (`performAndroidHapticsAsync`) | iOS                  |
| -------------------------------- | -------------------------------------- | -------------------- |
| `confirm` (transaction reviewed) | Confirm                                | notification success |
| `reject` (error)                 | Reject                                 | notification error   |
| `tick` (chart scrub)             | Segment_Tick                           | selection            |
| `toggleOn` / `toggleOff`         | Toggle_On / Toggle_Off                 | impact               |
| `tap`, `longPress`, `selection`  | Virtual_Key, Long_Press, Segment_Tick  | impact / selection   |

Settings > Haptics turns them all off. Compact skips scrub ticks.

## Motion and lists

Reanimated drives press feedback, switches, progress bars and sheets; Gesture Handler (v3 hook API, `usePanGesture`) drives chart scrubbing, sheet dragging and column resizing. Session A adds swipe right = reviewed, swipe left = skip with `react-native-gesture-handler/ReanimatedSwipeable`. Use FlashList for any list that can grow.

## Navigation

Phones show a bottom bar with Home, Transactions, Budgets, Net worth and More (Recurring, Accounts, Settings). At 900 px and wider the same seven screens sit in a left sidebar. Change the order in `navigation/tabs.ts`.
