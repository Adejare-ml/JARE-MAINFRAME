# Diet module: design

Status: **draft for the owner's sign-off.** No code, migration or Supabase change has been made for this module yet. Phase 1 starts only after this document is approved, and work stops again after Phase 1 for review.

This file adds a seventh module. It does not change any existing comment, docstring or note in the repo; where existing files are touched in later phases, notes are added beside the old ones, never in place of them.

Personal details (body measurements, targets, food preferences, name, city) are deliberately absent from this file. The repo is public, and the lifestyle skill's rule applies: preferences live in the owner's Supabase data, not in the repo. They are entered on the Diet settings screen.

---

## 1. Starting point: what already exists

The spec assumed six modules and no food tracking. The repo already has a **Meals** module:

| Piece | Where | What it does |
|---|---|---|
| Page | `src/pages/Meals.jsx`, route `/meals`, secondary nav slot | logs meals, 7-day bar strip |
| Table | `meals` (migrations `042_meals.sql`, `045_meal_calories_empty.sql`) | one row per meal, items as JSON, totals, a data-URL thumbnail |
| Write path | RPC `log_meal`, idempotent on `client_id` | |
| Logic | `src/lib/meals.js` (`dayTotals`, `targetProgress`, `sumMacros`, `daySeries`, `CALORIE_TARGET_KEY`) | tested in `tests/meals.test.js` |
| Prompt | `src/lib/mealPrompt.js`, about 80 Nigerian dish anchors | tested in `tests/mealPrompt.test.js` |
| Capture | `src/components/meals/MealCapture.jsx`, `src/lib/imagePrep.js` | camera via `capture="environment"`, downscale, exposure fix, thumbnail |
| Daily HQ card | `src/components/daily/FoodToday.jsx` | calories left today, camera one tap away |
| Edge Function | `supabase/functions/analyze-meal/index.ts` | Ollama Cloud first, NVIDIA fallback |
| Target | `user_settings.calorie_target` | edited in Settings → Meals |

**Decision (owner, this session): Diet replaces Meals.** Diet gets the tables the spec describes, reuses the capture, image and dish code, copies old `meals` rows into the new tables, and `/meals` redirects to `/diet`. The `meals` table is kept (not dropped) so nothing is lost and the backfill can be re-checked.

Reused as is: `imagePrep.js`, `MealCapture.jsx` camera handling, `mealPrompt.js` anchors (a seed source for `foods`), `src/lib/speech.js` (Phase 2), `Sheet`, `ProgressRing`, `EmptyState`, `ErrorState`, `NetWorthSparkline` with `lib/sparkline.js` (weight trend), `lib/export.js` `toCsv`, the local-date helpers in `lib/queries.js`, `useRealtimeRefresh`, `hasColumn` gating and `SchemaBanner`.

---

## 2. Data model

Migrations `048_diet_core.sql` onward, written in the style of `042_meals.sql`:

- header comment ending "Run after 0NN. Idempotent; safe to re-run."
- `create table if not exists`, then one `add column if not exists` per column
- `user_id uuid not null default auth.uid()` on every table, so the browser never stamps it
- one policy per table, `<table>_all_authenticated`, `for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)`
- RPCs `security invoker`, with `revoke execute ... from public, anon` and `grant ... to authenticated`
- a closing `do $$ ... raise exception ... $$` block that verifies columns, policies and constraints

### Tables

**`diet_settings`** (one row per user, unique on `user_id`)
Spec columns: `height_cm`, `weight_kg`, `kcal_target`, `protein_target_g`, `meal_split jsonb` (default `{"breakfast":0.20,"lunch":0.35,"dinner":0.30,"snacks":0.15}`, check: sums to 1).
Added because later phases need them and the spec does not say where they live:
`sex`, `birth_year` (for Mifflin-St Jeor), `activity_factor numeric default 1.375`, `display_name`, `city`, `avoid_foods text[]`, `substitutes text` (filled into the prompts), `photo_retention_days int` (null = keep), `nvidia_vision_model text`, `ollama_vision_model text`, `target_reviewed_at timestamptz`, `pending_target jsonb` (a proposal waiting for accept/reject).
The existing `user_settings.calorie_target` is copied in when the row is first created.

**`foods`**
`name`, `aliases text[]`, `kcal_per_100g`, `protein_g`, `carbs_g`, `fat_g` (all per 100 g as eaten), `typical_portion_g`, `portion_label`, `source text`, `estimated boolean`.
Seeded with about 60 common Nigerian foods. `source` names the table and row (FAO/INFOODS West African Food Composition Table where a row exists); every value not taken straight from a published row has `estimated = true` and a `source` note saying how it was derived. Seeds are shared reference data, not personal, so committing them is fine. Unique on `(user_id, lower(name))`.

**`recipes`** and **`recipe_ingredients`**
`recipes`: `name`, `portions int check (portions > 0)`, `notes`.
`recipe_ingredients`: `recipe_id`, `food_id`, `grams`.
The spec puts ingredients on the recipe as one field; a child table is proposed instead so each ingredient references a real `foods` row with a foreign key. Per-portion nutrition is computed (in JS and in a SQL function), never stored, so editing an ingredient updates every portion.
Seed: **Beans pot** = 1,000 g dry brown beans, 54 g palm oil, 150 g carrots, 300 g blended tomato and pepper, 5 portions.
One portion of a recipe is loggable like a food: `meal_items` may point at a recipe (`recipe_id`, nullable) as well as a food.

**`saved_meals`**
`name`, `items jsonb` (each `{food_id | recipe_id, name, grams}`), `meal_slot` (default slot), `sort_order`. Nutrition is computed from the referenced foods at log time, so the verdict can be computed in code (Phase 4).

**`meal_logs`**
Spec columns: `eaten_at timestamptz`, `meal_slot` (breakfast, lunch, dinner, snacks), `source` (photo, text, voice, saved), `photo_path`, `raw_text`, `status` (auto, confirmed, edited), `kcal`, `protein_g`, `carbs_g`, `fat_g`, `verdict` (fits, tight, over, null), `reason`.
Added: `client_id text` (unique; idempotent logging, as `log_meal` does), `eaten_on date` (local day in Africa/Lagos, so a 23:30 meal lands on the right day, as `meals.eaten_on` does), `thumbnail` (carried over from old `meals` rows), `legacy_meal_id` (backfill traceability), `needs_review boolean` (Phase 3 flags).

**`meal_items`**
Spec columns: `meal_id`, `food_id` (nullable), `name`, `grams`, `kcal`, `protein_g`, `carbs_g`, `fat_g`, `hidden boolean`, `confidence numeric`, `estimates jsonb`.
Added: `recipe_id` (nullable), `flagged boolean`, `flag_reason`.
`estimates` holds each model's raw estimate keyed by model, for example `{"claude": {...}, "nvidia": {...}, "ollama": {...}}`, so a later report can check which model came closest to the confirmed grams.

**`weight_logs`**: `logged_at date`, `weight_kg`. Unique on `(user_id, logged_at)`.

**`pantry_items`**: `name`, `quantity numeric`, `unit`, `cost_naira numeric`, `bought_at date`, `finished boolean default false`, `food_id` (nullable, for matching).

### Write path

RPC **`log_diet_meal(p_client_id, p_meal jsonb, p_items jsonb)`**, `security invoker`. In one transaction it inserts the log and its items and sets the meal's `kcal`, `protein_g`, `carbs_g`, `fat_g` to the sum of its items. Item edits go through `update_diet_meal`, which re-sums the same way. Because the meal total is always the item sum computed in SQL, the Daily Sheet's "totals equal the sum of the items" holds by construction, and a test checks it anyway.

### Views

- **`diet_daily_totals`**: per `eaten_on`, sums of kcal and macros, plus `kcal_left` and `protein_left` against `diet_settings`.
- **`diet_7day_average`**: rolling 7-day average of the daily totals, counting only days that have at least one log (so an unlogged day does not drag the average down to look like a deficit).

Both are created `with (security_invoker = true)` so RLS on the underlying tables applies. These are the first views in the repo.

### Backfill

Migration `049_diet_backfill.sql` copies every `meals` row into `meal_logs` (with `legacy_meal_id`, `source` mapped, `status = 'confirmed'`) and its `items` JSON into `meal_items`. Idempotent on `legacy_meal_id`. The verify block checks that the backfilled kcal per day equals the old per-day kcal.

### Storage (Phase 3)

Private bucket `meal-photos`, path `<user_id>/<yyyy>/<mm>/<meal_id>.jpg`, storage policies keyed on the first path segment matching `auth.uid()`. The browser reads photos only through signed URLs. **Decision (owner): photos are stored, with pruning.** At 1024 px a photo is roughly 150 KB, so the 1 GB free tier holds several years at three a day; an optional pg_cron job deletes photos older than `photo_retention_days`. This reverses the 042 note that photos are never stored; that note stays and a new one is added beside it explaining why.

### Repo housekeeping each migration needs

- `src/lib/schema.js` `GATED_COLUMNS`: one entry per new table so the app shows "run migration 048" instead of breaking.
- `src/lib/export.js` `EXPORT_TABLES`: every new table, or `tests/export.test.js` fails.
- `.github/workflows/ci.yml`: new `src/lib/diet/*.js` modules added to the plain-Node load list.
- `tests/sql/supabase-stubs.sql`: a `storage` schema stub before the Phase 3 migration, since `npm run test:db` applies every migration to a real Postgres.

---

## 3. Logic, tests first

Pure modules in `src/lib/diet/`, each with `tests/diet-<name>.test.js`, written before the module. Plain JS with explicit `.js` imports so the Edge Function and plain Node can import them unchanged (as `analyze-meal` imports `src/lib` today).

| Module | Does | Key tests |
|---|---|---|
| `nutrition.js` | grams × per-100 g, macro sums, rounding | 250 g at 130 kcal/100 g = 325; sum of items equals total; zero and missing values |
| `recipes.js` | per-portion nutrition from ingredients | Beans pot: total ÷ 5; changing portions changes per-portion only |
| `totals.js` | daily totals, left against target, 7-day average over logged days | unlogged days excluded; local-day boundary at midnight Lagos |
| `verdict.js` | fits / tight / over (rules below) | each branch, boundary values, null meal |
| `target.js` | Mifflin-St Jeor maintenance and proposal | known inputs; never below 1,800; exercise never added |
| `merge.js` (Phase 3) | ensemble merge | median grams; 25% disagreement flag; single-model flag; food-table recompute; confirmed meal untouched by a late estimate |
| `sheet.js` | Daily Sheet rows, CSV and XLSX | totals row equals the sum of rows; CSV escaping; XLSX read back |
| `parse.js` (Phase 2) | validate the model's item JSON, match names to foods and aliases | aliases, normalised names, unknown food stays unmatched |

### Verdict rules (computed in code for saved meals, and used to check the coach)

Let `target` be the day's kcal target, `slot_budget = target × meal_split[slot]`, `eaten_before` the kcal already logged today before this meal, and `meal` this meal's kcal.

- **fits**: the slot's total including this meal is at or under `slot_budget`.
- **tight**: the slot goes over its share, but `eaten_before + meal + minimum still to come` is at or under `target`. "Minimum still to come" is zero: the rule only asks whether the day can still end under target.
- **over**: `eaten_before + meal > target`.

### Target recalculation

Every 14 days from `target_reviewed_at`, using the latest `weight_logs` row:

- BMR (Mifflin-St Jeor) = 10 × kg + 6.25 × cm − 5 × age + 5 for men, − 161 for women.
- Maintenance = BMR × `activity_factor` (1.375).
- Proposed target = maintenance − (the current gap between the last maintenance and the current target), rounded to the nearest 50 kcal, floored at 1,800.
- Stored in `pending_target`; the app shows it and the owner accepts or rejects. Nothing changes automatically.
- Exercise never adds calories back to the daily budget.

The spec gives the formula and the floor but not the deficit; keeping the current gap is a proposal (see section 7).

---

## 4. Screens

Mobile-first, the existing Tailwind tokens (`bg-card rounded-3xl`, `min-h-[48px]` tap targets, `tabular-nums`, emoji icons). Route `/diet` with tabs; `/meals` and the PWA shortcut `/meals?snap=1` redirect to `/diet` and `/diet?snap=1`.

- **Today**: two rings, kcal left and protein left. Meals so far grouped by slot, each with its verdict. A row of saved-meal chips: one tap logs, with a toast that offers Undo (the existing pattern). Buttons for photo (opens the camera directly), text and voice; text and voice arrive in Phase 2, photo analysis in Phase 3, but manual entry by picking foods works in Phase 1.
- **Daily Sheet**: a date picker and a spreadsheet-style `<table>` (time, meal, item, grams, kcal, protein, carbs, fat), day totals row, 7-day average row. Scrolls horizontally on a phone with the item column pinned. Export as CSV and XLSX. This is the first `<table>` in the app.
- **Weight**: log a weigh-in, trend line from `NetWorthSparkline`, 7-day moving average.
- **Foods, recipes and saved meals**: list, add, edit. Recipes show per-portion nutrition live.
- **Pantry**: list with quantity, cost and "finished".
- **Diet settings**: measurements, targets, meal split (must add to 100%), avoid list and substitutes, model IDs, photo retention. Linked from the Diet page and from Settings.
- **Daily HQ card**: `FoodToday.jsx` gains protein left and reads the new tables; the camera stays one tap away.

---

## 5. Model ensemble and coach (Phases 2 to 4)

- **Where calls run.** The CSP in `public/_headers` limits `connect-src` to Supabase, so every model call goes through a Supabase Edge Function. The repo has no Cloudflare Pages Functions, so Edge Functions it is. Keys are set with `supabase secrets set` and never get a `VITE_` prefix.
- **Prompts.** `prompts/food-vision.md` and `prompts/coach.md` are committed with placeholders (`{{display_name}}`, `{{city}}`, `{{avoid_foods}}`, `{{substitutes}}`) and filled at call time from `diet_settings`. **Decision (owner): inject from settings**, so nothing personal is committed. A test checks that no placeholder survives filling.
- **Validation.** zod inside the Edge Functions (imported with Deno's `npm:` specifier, so it never enters the frontend bundle); pydantic in the Python worker. Invalid JSON: retry once, then skip that model for that meal and record the reason in `estimates`.

| Use | Model | Path |
|---|---|---|
| Text and voice parse, pantry updates | Claude `claude-haiku-5-5` | Edge Function `diet-parse` |
| Photo, model A | Claude `claude-sonnet-5-5`, one call per photo | Edge Function `diet-analyze` |
| Photo, model B | NVIDIA vision model from build.nvidia.com, ID in `diet_settings` | same function, run in parallel |
| Photo, model C | Ollama on the owner's laptop, a vision model that fits in 8 GB on its own (chosen in Phase 3 against the then-current catalogue) | Python worker, polls; never blocks a log |
| Verdict and "what next" | Claude `claude-haiku-5-5` | Edge Function `diet-coach`; skipped for saved meals with known numbers |

**Merge** (`src/lib/diet/merge.js`, shared by the function and, through the merge function, the worker): match items across models by normalised name and against `foods` names and aliases; median grams per item; if the item matches a food, recompute kcal and macros from the food table, otherwise median of the models' figures; flag an item when the models' grams differ by more than 25% (max over min) or only one model saw it.

**Ollama worker** (`workers/ollama/`, Python): polls `meal_logs` for photo meals without an Ollama estimate, downloads the photo by signed URL, runs the model with `keep_alive: 0`, validates, writes the estimate into `meal_items.estimates`, then calls the merge function. Reads its key from a git-ignored local `.env`. Opens no ports. If the meal is already `confirmed` or `edited`, the estimate is stored for comparison and the owner's numbers are left alone.

**Photo flow target:** under 30 seconds from tap to "Looks right", with Claude and NVIDIA in parallel and each capped by a timeout; whichever answers is merged, and Ollama is merged later if it ever arrives.

---

## 6. Phases

Each task ends with a verification step. A phase is reported done only after `npm run lint`, `npm test`, `npm run build` and `npm run test:db` pass and the screens have been checked in a browser against a real database.

### Phase 1: tracking without AI (then stop for review)

1. `docs`: this file approved.
2. Tests then `nutrition.js`, `recipes.js`, `totals.js`, `verdict.js`, `target.js`, `sheet.js`. Verify: `npm test`.
3. Migration 048: tables, RLS, `log_diet_meal`, `update_diet_meal`, views. Verify: `npm run test:db`, verify block passes.
4. Migration 049: food seeds, Beans pot, backfill from `meals`. Verify: per-day kcal before and after match.
5. `schema.js`, `export.js`, `ci.yml` housekeeping. Verify: `tests/export.test.js`, CI load loop.
6. Diet settings screen. Verify in browser: values saved and read back.
7. Today screen with manual entry and saved meals. Verify: one tap logs a saved meal; rings update.
8. Daily Sheet with CSV and XLSX export. Verify: totals equal the rows; the XLSX opens in Excel (or LibreOffice here, and the owner confirms in Excel).
9. Weight screen. Verify: trend line with two or more entries.
10. Daily HQ card and `/meals` redirect. Verify: card shows kcal and protein left; old bookmark lands on `/diet`.

### Phase 2: text and voice
`_headers` microphone change; fix the broken `normalize.js` import; `diet-parse` function with Claude Haiku; text box and mic (en-NG where supported, else en-US); pantry updates through the same parser.

### Phase 3: photo with three models
Storage bucket and policies; client compression to 1024 px; `diet-analyze` with Claude and NVIDIA; `merge.js`; review screen ("Looks right", gram steppers, flagged items first); Python Ollama worker; optional photo pruning.

### Phase 4: coach
`diet-coach` after each log (code verdict for saved meals); "What should I eat next?"; 14-day target proposal with accept and reject.

---

## 7. Clashes with the repo, and open points for sign-off

1. **Commit style.** The repo's commits are plain sentences or migration-number prefixes (`047: reconcile carries …`), squash-merged with the PR number. The spec asks for `type(scope): description`. Proposal: use the spec's style on the branch; the squash-merge title is the owner's choice.
2. **Branch.** The spec names `feature/diet-module`; this cloud session can push only to `claude/relaxed-ritchie-567ibw`. **Decision (owner): use the session branch.**
3. **Navigation.** `tests/nav.test.js` caps the phone's bottom bar at five items. Proposal: Diet takes Meals' secondary slot (header gear, then Modules), plus the Daily HQ card and the PWA "Log a meal" shortcut, which are the fast paths anyway. Alternative: put Diet in the bottom bar in place of another item. Owner's call.
4. **XLSX library.** None is installed, and the repo keeps the bundle small for mobile data. Proposal: `write-excel-file`, loaded with a dynamic `import()` only when Export is tapped, so it costs nothing on normal page loads.
5. **zod.** The repo validates with hand-written parsers. Proposal: zod only inside Edge Functions, per the spec, so the frontend bundle does not grow.
6. **Microphone.** `public/_headers` sets `microphone=()`, which blocks the mic for the whole site. Phase 2 changes it to `microphone=(self)`. `src/components/daily/DictateDay.jsx` is affected by this today too.
7. **Edge Functions have never been deployed**, and both import `../../../src/lib/sync/normalize.js`, which moved to `src/lib/normalize.js` in #180. Neither function would deploy as is. Phase 2 is the first real deployment and fixes the import (with an added note).
8. **Anthropic key.** None exists in the project. Before Phase 2 the owner sets `ANTHROPIC_API_KEY` with `supabase secrets set`; it is never sent to the browser.
9. **Ollama.** The existing code uses Ollama Cloud; the spec wants the laptop for the ensemble. Proposal: the laptop worker is a separate thing; the Ollama Cloud planner and recap scripts are left alone.
10. **Worker credentials.** The worker runs on the laptop with no user session. Proposal: the service-role key in a git-ignored `.env` on the laptop, as `scripts/*.mjs` already use it in Actions, with every write scoped to the owner's `user_id`. A narrower option is a dedicated Postgres role with access to only the two tables; more setup, smaller blast radius.
11. **Target deficit.** The spec gives Mifflin-St Jeor, the 1.375 factor and the 1,800 floor, but not how far below maintenance the target sits. Proposal: keep the current gap; the owner can set a different one in settings.
12. **Food data.** Values come from FAO/INFOODS West African table rows where one can be cited; dishes the table lacks (for example a specific mama put serving) are built from ingredients and marked `estimated`. The owner should expect to adjust a few portion sizes after the first weeks.
13. **Browser verification.** This container has no Supabase credentials, and migrations here are applied by hand. Proposal: apply Phase 1 migrations to a Supabase branch (or to the live project, with the owner's go-ahead each time) and check the screens against it with Playwright before reporting Phase 1 done.
14. **Firsts.** Database views, a storage bucket, an HTML `<table>`, a Python worker and a third AI provider are all new to this repo. They are listed here so each is a choice, not an accident.
15. **Old Meals module.** Its page, card and `analyze-meal` function are kept in the tree until Diet covers everything they do, then retired in a separate, reviewable commit. The `meals` table stays.

---

## 8. Phase 1 build notes (added after sign-off)

Added when Phase 1 was built, so a teammate can follow what was done and why. Nothing above this section was changed.

### What was built

- **Logic, test-first** (`src/lib/diet/`, `tests/diet-*.test.js`, 74 tests): nutrition, recipes, totals and the 7-day average, settings, verdict, target, food search, Daily Sheet. All load under plain Node and are in the CI load list.
- **Migrations**, numbered differently from section 2, which named 048 and 049:
  - `048_diet.sql`: the nine tables, RLS, `log_diet_meal`, the two pricing and summing triggers, and the two views.
  - `049_diet_seed.sql`: 65 foods, the Beans pot, two saved meals, and a settings row.
  - `050_diet_backfill.sql`: the copy of `meals`.
  - Run them in that order in the SQL editor. Each is idempotent and ends with a verify block.
- **`scripts/db-test.mjs`**: five Diet checks, run as the signed-in owner (role `authenticated`):
  - pricing from foods and recipes;
  - idempotency on a client id;
  - sheet totals equal the sum of their items, in the view as well;
  - the Lagos day boundary;
  - the 7-day average skipping unlogged days;
  - the backfill, run twice;
  - a second account seeing nothing.
- **Screens**:
  - `/diet` with five tabs: Today, Sheet, Weight, Library, Settings.
  - `DietCard` on Daily HQ in place of `FoodToday`.
  - `/meals` redirects to `/diet`, keeping the query string.
  - The PWA shortcut now opens `/diet?add=1`.
  - The Meals nav entry is hidden rather than deleted, so its comment stays.

### Decisions made while building

- **Every seeded food is marked `estimated`.** fao.org was unreachable from the build machine (network policy), so no figure was checked against WAFCT 2019. Each row's `source` says so. Editing a food in Library clears the mark.
- **Item and meal figures are computed in the database by triggers**, not only in `log_diet_meal`. A direct edit in the table editor still re-prices and re-sums. Free items, with no food behind them, keep the figures they were given.
- **Sources gain `manual`**, for meals picked food by food on the Today screen. The spec's four sources had no value for a hand-entered meal.
- **`recipes.cooked_weight_g`** is optional. Without it, grams per portion is raw weight divided by portions, which understates the cooked plate. The kcal per portion is right either way.
- **XLSX uses `write-excel-file/universal`**, imported only when Export is tapped (a separate chunk of about 70 kB). The library's browser build writes in a `blob:` Web Worker, which the CSP (`worker-src 'self'`) blocks.
- **The verdict is computed in code for every Phase 1 meal.** All Phase 1 meals have known numbers, so no model is involved.
- **Settings → Meals keeps its old calorie-target field**, with a pointer to Diet settings. Removing it means rewriting the code and comments around it, which this build does not do. Nothing reads that field now. Suggest removing it in a later change.
- **The old Meals files are still in the tree.** `Meals.jsx`, `FoodToday.jsx`, `MealCapture.jsx` and the `meals` table are kept for Phase 3, which reuses the capture code.

### Issues found and fixed during the browser check

The check ran on a local copy: Postgres 16 with every migration applied, PostgREST 12 in Docker, and a stub for Supabase auth. Playwright drove it as an iPhone 13 and a Pixel 7 in the Lagos time zone.

1. **The Daily Sheet widened the whole page on a phone** (634 px on a 390 px screen), so taps landed off target and the export buttons could not be pressed. The `sr-only` header label (`position: absolute`) was laid out against the page rather than the table's scroller. Fixed by making the scroller `relative`.
2. **On a phone, kcal was off-screen in the sheet.** On screen, time and meal now share one two-line cell. The files keep all eight columns.
3. **Breakfast listed after lunch when both were logged in the same minute.** Rows now sort by minute, then by slot. A test was added.
4. **`/meals?snap=1` lost its query string**, so the old home-screen shortcut did not open the add sheet. The redirect now carries the query string.
5. **`log_diet_meal` called `auth.uid()` explicitly.** That needs USAGE on the `auth` schema, which the harness stubs do not grant. RLS already scopes the lookup, so the call was removed.

### Known limitation, not specific to Diet

The light theme is a partial first slice (see `src/index.css`). Every page, Diet included, writes `text-white`, so numbers are unreadable in light mode. In the check, Diet was reviewed in dark mode, the app's default. The per-page light-theme pass is still open for the whole app.

### Checked

- `npm run lint`: 0 errors. The warnings are the React Compiler `set-state-in-effect` warnings that every page has.
- `npm test`: 1,122 passing.
- `npm run build`: clean.
- `npm run test:db`: 32 of 32.
- In the browser, all of these work:
  - targets saved;
  - a saved meal logs in one tap, in under 100 ms against the local database;
  - a meal built from the Beans pot and an orange;
  - verdicts shown;
  - Sheet totals equal to the sum of its rows (kcal, protein, carbs, fat);
  - an edit of the grams re-prices the item and the day;
  - CSV and XLSX download on desktop and phone;
  - the XLSX opens in LibreOffice and openpyxl, with numbers stored as numbers and totals matching;
  - two weigh-ins draw the trend;
  - the Daily HQ card shows kcal and protein left;
  - the old shortcut opens the add sheet.
- **Not checked: Excel itself.** It was not available on the build machine.
- **Not checked: the live Supabase project.** No migration has been applied to it.
