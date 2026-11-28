# Jare Mainframe design system

The binding decisions behind this live in the redesign spec (tokens, type, motion, emoji policy, the naira rule). This page is the working reference for anyone building a page. "Mainframe" means a system of record that reports its own state, treats numbers as the hero and shows where data came from. It is not a costume: no scanlines, glow, typewriter text or jargon.

## Rules

- **Compose, don't restyle.** Pages use `PageHeader`, `Panel`, `ListRow` and the other primitives in `src/components/ui/`. No local card, button or input styling.
- **Tokens only.** No hex, no `-[#…]`, no `white/NN` or `black/NN`, no white or black literal classes. `node scripts/check-style.mjs <files>` enforces this and the emoji rule.
- **No emoji** anywhere, and no pictograph stand-ins (check marks, crosses, stars, warning signs). Use `<Icon>` or words. Toasts are plain sentences; the container adds a status dot.
- **Colour means state.** Green: OK, positive money, primary action. Amber: attention. Red: fault, negative, destructive. Neutral information is never coloured, and every status colour comes with a word or a glyph. Expense amounts are `foreground`; only income and positive deltas are `accent`.
- **Text is 12px or larger.** Uppercase only in the `label` step. Mono (IBM Plex Mono) only for labels and data, never for body text or money.
- **48px targets.** `Button size="sm"` and `IconButton` keep a 48px hit area. Every glyph-only control has a label.
- **One `display` figure per page**, through `Readout size="display"`.
- **Off limits to page agents:** `src/index.css`, `src/components/ui/*`, `src/components/layout/*`, `src/lib/nav.js`, `src/lib/constants.js`, `src/lib/categories.js`. If a primitive lacks something, write it in the scratchpad's `primitive-requests.md` and compose locally.

## Tokens (`src/index.css`)

Colours are utilities: `bg-*`, `text-*`, `border-*` with these names. Solid hex in all three themes (dark default, `data-theme="light"`, `data-oled="true"`), each text pair at 4.5:1 or better and both borders at 3:1 on every surface (`tests/contrast.test.js`).

| Token | Use |
|---|---|
| `background` | page |
| `card` | panel surface |
| `surface-2` | inputs, pressed or selected rows, chips, icon tiles, skeletons |
| `foreground` | primary text and figures |
| `muted` | secondary text, labels |
| `muted-dim` | tertiary text, provenance |
| `hint` | placeholders only |
| `border` | every panel outline, divider, control outline |
| `border-strong` | focused or active control outline |
| `accent` | OK, positive money, primary fill, focus ring |
| `on-accent` | text on an accent, warn or danger fill (`bg-accent text-on-accent`) |
| `warn` | attention |
| `danger` | fault, negative, destructive |

Elevation is by surface (background, card, surface-2), never shadow. No gradients, no blur.

Radius: `rounded-panel` and `rounded-control` 6px, `rounded-chip` 4px, `rounded-sheet` 10px (sheet tops). Tailwind's own `rounded-xl/2xl/3xl` now mean 6px and `rounded-lg/md` 4px. `rounded-full` only for status dots, progress tracks, avatars and the QuickLog button.

Spacing: page gutter 16px, 12px between panels (`space-y-3`), panel padding 12px (16px at `lg`), rows 48px (56px with a subtitle) with 12px side padding.

## Type scale

| Class | Size/line | Weight | Use |
|---|---|---|---|
| `text-display` | 32/36 | 600 | the page's one hero figure |
| `text-figure` | 22/28 | 600 | panel readouts |
| `text-title` | 18/24 | 600 | page and sheet titles |
| `text-heading` | 15/20 | 600 | emphasised row text, buttons |
| `text-body` | 15/22 | 400 | default text, row titles |
| `text-body-sm` | 13/18 | 400 | subtitles, helper and error text, toasts |
| `type-label` | 12/16 | 500 mono, uppercase, 0.06em | panel labels, field labels, badges (or `<Label>`) |
| `type-data` | 13/18 | 400 mono | timestamps, provenance, counts, IDs |

Money is always Inter weight 500+, through `Money` or `Readout` (they force `font-sans`, so a `₦` inside a mono line still renders in Inter). Numerals are tabular everywhere.

## Primitives (`src/components/ui/`)

| Component | Props | Notes |
|---|---|---|
| `Icon` | `name, size=20, className, title` | 77 inline-SVG glyphs (see `/__kit`). Names are 8 characters max. Decorative unless `title`. |
| `Panel` | `label, meta, action, flush, tone, className` | Bordered surface with the header strip (mono label, data meta, action, rule below). `flush` drops body padding for row lists. `tone="warn"/"danger"` adds a 2px left rule. |
| `PageHeader` | `title, meta, actions` | Title step, data-step meta above it, actions on the right. |
| `Readout` | `value, kind='naira'\|'number'\|'percent', label, unit, size='display'\|'figure', tone, sub` | Applies the naira overflow rule (below); exact value in `title`/`aria-label`. |
| `Money` | `amount, kobo=true, sign=false, tone, className` | Inline amount, `.money` for zen mode, U+2212 for negatives, `sign` adds `+`. |
| `Stat` | `label, value, tone` | Label over value, for grids. Pass `<Money>` as the value. |
| `ListRow` / `ListRows` | `leading, title, subtitle, meta, trailing, onClick, to, isNew, wrap, label` | Title truncates, trailing never shrinks. `to` renders a Link, `onClick` a button. `isNew` plays the row-insertion motion. `wrap` lets the subtitle take two lines. Wrap rows in `<ListRows>` inside a `flush` Panel. |
| `Label` | `children, as` | The `label` step. |
| `Button` | `variant='primary'\|'secondary'\|'ghost'\|'danger', size='md'\|'sm', icon, loading, full, to` | `buttonClasses()` is exported for a `<label>` that must look like a button (file inputs). `Spinner` is exported too. |
| `IconButton` | `name, label (required), variant='ghost'\|'secondary'\|'primary', to` | 48px square. |
| `Field`, `Input`, `Select`, `Textarea` | `label, hint, error` (+ native props) | `controlClasses(invalid)` is exported for a bare control. Inputs render at 16px. |
| `Segmented` | `options, value, onChange, label, tabs, idPrefix, full` | Replaces pill-chip rows. With `tabs`, ids are `${idPrefix}-tab-${value}` / `${idPrefix}-panel-${value}`. |
| `StatusDot` | `status, pulseOnce` | `ok, attention, failing, stale, never, offline, loading` (health.js STATUS) plus `accent, warn, danger, muted`. Always beside words. |
| `StatusRail` / `StatusJobList` | none | Read `useSystemStatus()`; mounted by Layout only. |
| `Provenance` | `source, at` | "GTBank alert · 09:41" from `transactions.source` and `transaction_time`. Renders nothing when there is nothing true to say. |
| `ProgressBar` | `value, max=100, tone, label` | 4px track. |
| `CategoryMark` | `category, size='md'\|'sm'` | 16px glyph in a 28px surface-2 tile, beside the plain category name. |

Restyled with unchanged APIs: `Badge` (now takes `tone`), `EmptyState` (ignores `icon`), `ErrorState`, `Sheet`, `ToastContainer`, `Skeleton`, `PageSkeleton`, `ProgressRing` (pass `color="var(--color-warn)"` etc.), `WalletCard`, `CategoryBreakdown`, `CategoryPickerList`, `CategoryPickerSheet`, `MonthRecap`, `NetWorthSparkline`, `QuickLog`, `SchemaBanner`, `ZenModeToggle`.

## Icons and stored emoji

`CATEGORY_ICONS`, `GOAL_ICONS`, `CUSTOM_CATEGORY_ICONS` and `nav.js` icons are glyph names. `getCategoryIcon(category)` returns a glyph name. `goals.icon` and `categories.icon` may still hold emoji from before: always render them through `resolveIcon(value, 'goal' | 'tag')` (`src/lib/constants.js`), never raw.

## Naira overflow rule

Figures never wrap, truncate or scroll. `Readout` at `display`: whole naira; 32px up to 11 characters, 26px for 12 to 14, 22px for 15 or more; ₦1,000,000,000 and over compact ("₦1.23B"). At `figure`: 22px up to 10 characters, 18px beyond; kobo only under ₦100,000. Two readouts side by side at 360px only at `figure` size; stack them if either passes 10 characters. Rows always show kobo and put the amount in `trailing`. Helpers: `formatNairaSigned`, `formatNairaWhole`, `formatNairaCompact` in `src/lib/formatters.js`.

## Motion

CSS only, transform and opacity, transitions over keyframes. Tokens: `--ease-out`, `--ease-standard`, `--dur-press` 120ms, `--dur-state` 180ms, `--dur-sheet` 260ms. What moves: button press (`.press`, built into Button/IconButton), sheets, toasts, rows inserted after mount (`ListRow isNew`, or `.row-enter`), the one-time sync pulse, progress changes, the segmented indicator, and the kept shake / milestone / check-pop. Nothing animates on page load: `.animate-fade-in` and `.animate-slide-up` are no-ops now, so delete them from your page. No count-ups, staggers, shimmer, hover scale or looping pulses (`animate-pulse` included). Reduced motion turns transforms off.

## Status rail

`useSystemStatus()` (`src/lib/useSystemStatus.js`) reads `sync_runs` once for the app (refetch on mount and on tab focus, at most every five minutes) and exposes `{ rows, rail, pulseKey, available, loading, failed, online, refresh }`. Read `rows` instead of querying `sync_runs` yourself. Words come from `src/lib/systemStatus.js`. The rail links to `/settings#system`: Settings should give the System section `id="system"` and scroll to it (a G5 item).

## Tools

- `/__kit` (DEV only, no sign-in): every primitive in every state, with theme buttons.
- `?fixture` on any dev URL: a DEV-only fixture session (`src/dev/fixture.js`) with plausible data, no backend needed. Rail scenarios: `?fixture=ok|attention|failing|stale|never|offline|nomigration`; `?fixture=off` leaves. `main.jsx` imports it behind `import.meta.env.DEV`, so `npm run build` drops it (check: `grep -rl jare_fixture dist` finds nothing).
- `npm run shots -- <route...> [--themes dark,light,oled] [--scenario stale] [--time 20:30] [--out dir] [--prefix name]`: 360 x 740 screenshots (viewport and full page) at a fixed Lagos clock (default 10:30), using the global Playwright install. It reports horizontal overflow and text under 12px.
- `node scripts/check-style.mjs <files...>`: emoji and raw-colour check; exits 1 with file:line.
