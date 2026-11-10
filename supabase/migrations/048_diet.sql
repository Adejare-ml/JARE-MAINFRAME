-- ============================================================================
-- 048_diet.sql
--
-- Run after 047. Idempotent; safe to re-run.
--
-- The Diet module, Phase 1: tracking without AI (docs/diet-module.md).
-- Diet replaces Meals (042) as the owner's food log. 042's `meals` table is
-- kept, not dropped; 050 copies its rows into the tables here.
--
--   diet_settings       one row: measurements, targets, meal split, food rules
--   foods               per-100 g composition, with aliases for matching
--   recipes             a pot divided into portions ...
--   recipe_ingredients  ... made of foods by raw weight
--   saved_meals         one-tap meals ("Beans container")
--   meal_logs           one row per meal: when, which slot, how it was logged
--   meal_items          what the meal was made of, item by item
--   weight_logs         weigh-ins
--   pantry_items        food at home, for the coach (Phase 4)
--
-- Same shape as 042: owner-owned rows, `user_id default auth.uid()`, one
-- `<table>_all_authenticated` policy each, writes idempotent on a client id.
--
-- Two rules are enforced here rather than trusted to the client, so a
-- figure on any screen, in either export, and in the Phase 3 model
-- comparison is the same figure:
--
--   1. An item that names a food (or a recipe) has its kcal and macros
--      computed from that food (or recipe) and its grams (or portions),
--      whatever the client sent. diet_item_figures, a BEFORE trigger.
--   2. A meal's kcal and macros are the sum of its items, kept so by an
--      AFTER trigger on meal_items. A total cannot drift from its rows.
--
-- Rounding matches src/lib/diet/nutrition.js: kcal a whole number per item,
-- macros one decimal place, sums taken over the rounded items.
--
-- Days are Lagos days: eaten_on defaults to the date in Africa/Lagos, not
-- the server's UTC date (see src/lib/diet/totals.js).
--
-- Also the first views in this project (diet_daily_totals and
-- diet_7day_average), created with security_invoker so they answer through
-- the caller's RLS like the tables under them.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------

/** Today in Lagos. The default for every Diet date column. */
create or replace function diet_today() returns date
language sql
stable
as $$
  select (now() at time zone 'Africa/Lagos')::date
$$;

revoke execute on function diet_today() from public, anon;
grant  execute on function diet_today() to authenticated;

/** True when a meal split is an object of the four slots, each 0..1, adding up to 1. */
create or replace function diet_split_ok(p jsonb) returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p) k
           where k in ('breakfast', 'lunch', 'dinner', 'snacks')) = 4
     and (select bool_and(jsonb_typeof(p->k) = 'number' and (p->>k)::numeric between 0 and 1)
            from unnest(array['breakfast', 'lunch', 'dinner', 'snacks']) k)
     and abs((p->>'breakfast')::numeric + (p->>'lunch')::numeric
             + (p->>'dinner')::numeric + (p->>'snacks')::numeric - 1) < 0.001
$$;

revoke execute on function diet_split_ok(jsonb) from public, anon;
grant  execute on function diet_split_ok(jsonb) to authenticated;


-- ---------------------------------------------------------------------------
-- 1. diet_settings: one row per owner
--
-- Every column but the split is optional. The owner's details are typed in
-- on the Diet settings screen and never committed (the repo is public).
-- weight_kg is the weight the current kcal_target was set at; the 14-day
-- recalculation (src/lib/diet/target.js, Phase 4) measures the gap below
-- maintenance against it.
-- ---------------------------------------------------------------------------

create table if not exists diet_settings (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid(),
  display_name         text,
  city                 text,
  sex                  text,
  birth_year           integer,
  height_cm            numeric,
  weight_kg            numeric,
  kcal_target          integer,
  protein_target_g     integer,
  activity_factor      numeric not null default 1.375,
  meal_split           jsonb not null default '{"breakfast":0.20,"lunch":0.35,"dinner":0.30,"snacks":0.15}'::jsonb,
  avoid_foods          text[] not null default '{}',
  substitutes          text,
  -- Phase 3: photos older than this are deleted; null keeps them.
  photo_retention_days integer,
  -- Phase 3: the model IDs, kept here so a catalogue change is a settings edit.
  nvidia_vision_model  text,
  ollama_vision_model  text,
  -- Phase 4: when the target was last reviewed, and a proposal awaiting a yes.
  target_reviewed_at   timestamptz,
  pending_target       jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table diet_settings add column if not exists user_id              uuid not null default auth.uid();
alter table diet_settings add column if not exists display_name         text;
alter table diet_settings add column if not exists city                 text;
alter table diet_settings add column if not exists sex                  text;
alter table diet_settings add column if not exists birth_year           integer;
alter table diet_settings add column if not exists height_cm            numeric;
alter table diet_settings add column if not exists weight_kg            numeric;
alter table diet_settings add column if not exists kcal_target          integer;
alter table diet_settings add column if not exists protein_target_g     integer;
alter table diet_settings add column if not exists activity_factor      numeric not null default 1.375;
alter table diet_settings add column if not exists meal_split           jsonb not null default '{"breakfast":0.20,"lunch":0.35,"dinner":0.30,"snacks":0.15}'::jsonb;
alter table diet_settings add column if not exists avoid_foods          text[] not null default '{}';
alter table diet_settings add column if not exists substitutes          text;
alter table diet_settings add column if not exists photo_retention_days integer;
alter table diet_settings add column if not exists nvidia_vision_model  text;
alter table diet_settings add column if not exists ollama_vision_model  text;
alter table diet_settings add column if not exists target_reviewed_at   timestamptz;
alter table diet_settings add column if not exists pending_target       jsonb;
alter table diet_settings add column if not exists created_at           timestamptz not null default now();
alter table diet_settings add column if not exists updated_at           timestamptz not null default now();

-- The ranges mirror RANGES in src/lib/diet/settings.js.
alter table diet_settings drop constraint if exists diet_settings_ranges;
alter table diet_settings add  constraint diet_settings_ranges check (
      (sex is null or sex in ('male', 'female'))
  and (birth_year is null or birth_year between 1900 and 2100)
  and (height_cm is null or height_cm between 100 and 250)
  and (weight_kg is null or weight_kg between 30 and 400)
  and (kcal_target is null or kcal_target between 1000 and 6000)
  and (protein_target_g is null or protein_target_g between 0 and 400)
  and activity_factor between 1.2 and 1.9
  and (photo_retention_days is null or photo_retention_days between 7 and 3650)
);

alter table diet_settings drop constraint if exists diet_settings_split_ok;
alter table diet_settings add  constraint diet_settings_split_ok check (diet_split_ok(meal_split));

create unique index if not exists diet_settings_user_idx on diet_settings (user_id);


-- ---------------------------------------------------------------------------
-- 2. foods, recipes, recipe_ingredients, saved_meals
-- ---------------------------------------------------------------------------

create table if not exists foods (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid(),
  name              text not null,
  -- Other names to match on: the Nigerian name, a plural, a common spelling.
  aliases           text[] not null default '{}',
  -- Per 100 g as eaten (cooked weight for cooked dishes).
  kcal_per_100g     numeric not null,
  protein_g         numeric not null default 0,
  carbs_g           numeric not null default 0,
  fat_g             numeric not null default 0,
  typical_portion_g numeric,
  portion_label     text,
  -- Where the figures came from, in words. Required for seeded rows.
  source            text,
  -- True when the figures are an estimate rather than a published row.
  estimated         boolean not null default false,
  created_at        timestamptz not null default now()
);

alter table foods add column if not exists user_id           uuid not null default auth.uid();
alter table foods add column if not exists name              text;
alter table foods add column if not exists aliases           text[] not null default '{}';
alter table foods add column if not exists kcal_per_100g     numeric;
alter table foods add column if not exists protein_g         numeric not null default 0;
alter table foods add column if not exists carbs_g           numeric not null default 0;
alter table foods add column if not exists fat_g             numeric not null default 0;
alter table foods add column if not exists typical_portion_g numeric;
alter table foods add column if not exists portion_label     text;
alter table foods add column if not exists source            text;
alter table foods add column if not exists estimated         boolean not null default false;
alter table foods add column if not exists created_at        timestamptz not null default now();

alter table foods drop constraint if exists foods_figures_ok;
alter table foods add  constraint foods_figures_ok check (
      length(trim(name)) > 0
  and kcal_per_100g between 0 and 950
  and protein_g between 0 and 100
  and carbs_g between 0 and 100
  and fat_g between 0 and 100
  and (typical_portion_g is null or typical_portion_g between 1 and 5000)
);

create unique index if not exists foods_user_name_idx on foods (user_id, lower(name));

create table if not exists recipes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  name            text not null,
  portions        numeric not null default 1,
  -- Weighed after cooking, when it was. Only changes grams per portion.
  cooked_weight_g numeric,
  notes           text,
  created_at      timestamptz not null default now()
);

alter table recipes add column if not exists user_id         uuid not null default auth.uid();
alter table recipes add column if not exists name            text;
alter table recipes add column if not exists portions        numeric not null default 1;
alter table recipes add column if not exists cooked_weight_g numeric;
alter table recipes add column if not exists notes           text;
alter table recipes add column if not exists created_at      timestamptz not null default now();

alter table recipes drop constraint if exists recipes_ok;
alter table recipes add  constraint recipes_ok check (
  length(trim(name)) > 0 and portions > 0 and portions <= 100
  and (cooked_weight_g is null or cooked_weight_g between 1 and 50000)
);

create unique index if not exists recipes_user_name_idx on recipes (user_id, lower(name));

-- A child table rather than a jsonb column on recipes, so every ingredient
-- is a real foods row (a foreign key) and a food in use cannot be deleted
-- out from under a recipe.
create table if not exists recipe_ingredients (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  recipe_id  uuid not null references recipes(id) on delete cascade,
  food_id    uuid not null references foods(id) on delete restrict,
  grams      numeric not null,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

alter table recipe_ingredients add column if not exists user_id    uuid not null default auth.uid();
alter table recipe_ingredients add column if not exists position   integer not null default 0;
alter table recipe_ingredients add column if not exists created_at timestamptz not null default now();

alter table recipe_ingredients drop constraint if exists recipe_ingredients_grams_ok;
alter table recipe_ingredients add  constraint recipe_ingredients_grams_ok check (grams > 0 and grams <= 20000);

create index if not exists recipe_ingredients_recipe_idx on recipe_ingredients (recipe_id, position);
create index if not exists recipe_ingredients_food_idx on recipe_ingredients (food_id);

-- items: [{"food_id": "...", "grams": 150} | {"recipe_id": "...", "portions": 1}, ...]
-- Only references and amounts: the figures are computed when the meal is
-- logged, from the foods as they are then.
create table if not exists saved_meals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  name       text not null,
  items      jsonb not null default '[]'::jsonb,
  meal_slot  text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table saved_meals add column if not exists user_id    uuid not null default auth.uid();
alter table saved_meals add column if not exists items      jsonb not null default '[]'::jsonb;
alter table saved_meals add column if not exists meal_slot  text;
alter table saved_meals add column if not exists sort_order integer not null default 0;
alter table saved_meals add column if not exists created_at timestamptz not null default now();

alter table saved_meals drop constraint if exists saved_meals_ok;
alter table saved_meals add  constraint saved_meals_ok check (
  length(trim(name)) > 0 and jsonb_typeof(items) = 'array'
  and (meal_slot is null or meal_slot in ('breakfast', 'lunch', 'dinner', 'snacks'))
);

create unique index if not exists saved_meals_user_name_idx on saved_meals (user_id, lower(name));


-- ---------------------------------------------------------------------------
-- 3. meal_logs and meal_items
-- ---------------------------------------------------------------------------

create table if not exists meal_logs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid(),
  -- Minted by the client; the idempotency key, as in 042.
  client_id      text not null,
  eaten_at       timestamptz not null default now(),
  eaten_on       date not null default diet_today(),
  meal_slot      text not null default 'snacks',
  -- photo, text, voice and saved are the spec's; manual is a meal picked
  -- food by food on the Today screen (Phase 1's main way in).
  source         text not null default 'manual',
  -- Phase 3: the object path in the private meal-photos bucket.
  photo_path     text,
  raw_text       text,
  -- auto: as the models left it; confirmed: "Looks right"; edited: changed.
  status         text not null default 'confirmed',
  -- Maintained by meal_items_sum; never written by the client.
  kcal           integer not null default 0,
  protein_g      numeric not null default 0,
  carbs_g        numeric not null default 0,
  fat_g          numeric not null default 0,
  verdict        text,
  reason         text,
  -- Phase 3: an item the models disagree on is waiting for a look.
  needs_review   boolean not null default false,
  saved_meal_id  uuid references saved_meals(id) on delete set null,
  -- The 042 meals row this was copied from (050), for checking the copy.
  legacy_meal_id uuid,
  -- Carried over from 042; new logs leave it null.
  thumbnail      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table meal_logs add column if not exists user_id        uuid not null default auth.uid();
alter table meal_logs add column if not exists client_id      text;
alter table meal_logs add column if not exists eaten_at       timestamptz not null default now();
alter table meal_logs add column if not exists eaten_on       date not null default diet_today();
alter table meal_logs add column if not exists meal_slot      text not null default 'snacks';
alter table meal_logs add column if not exists source         text not null default 'manual';
alter table meal_logs add column if not exists photo_path     text;
alter table meal_logs add column if not exists raw_text       text;
alter table meal_logs add column if not exists status         text not null default 'confirmed';
alter table meal_logs add column if not exists kcal           integer not null default 0;
alter table meal_logs add column if not exists protein_g      numeric not null default 0;
alter table meal_logs add column if not exists carbs_g        numeric not null default 0;
alter table meal_logs add column if not exists fat_g          numeric not null default 0;
alter table meal_logs add column if not exists verdict        text;
alter table meal_logs add column if not exists reason         text;
alter table meal_logs add column if not exists needs_review   boolean not null default false;
alter table meal_logs add column if not exists saved_meal_id  uuid;
alter table meal_logs add column if not exists legacy_meal_id uuid;
alter table meal_logs add column if not exists thumbnail      text;
alter table meal_logs add column if not exists created_at     timestamptz not null default now();
alter table meal_logs add column if not exists updated_at     timestamptz not null default now();

alter table meal_logs drop constraint if exists meal_logs_ok;
alter table meal_logs add  constraint meal_logs_ok check (
      length(trim(client_id)) > 0
  and meal_slot in ('breakfast', 'lunch', 'dinner', 'snacks')
  and source in ('photo', 'text', 'voice', 'saved', 'manual')
  and status in ('auto', 'confirmed', 'edited')
  and (verdict is null or verdict in ('fits', 'tight', 'over'))
  and kcal between 0 and 30000
  and (thumbnail is null or (length(thumbnail) <= 8000 and thumbnail like 'data:image/%'))
);

create unique index if not exists meal_logs_user_client_idx on meal_logs (user_id, client_id);
create unique index if not exists meal_logs_user_legacy_idx on meal_logs (user_id, legacy_meal_id) where legacy_meal_id is not null;
create index if not exists meal_logs_user_day_idx on meal_logs (user_id, eaten_on desc, eaten_at);

create table if not exists meal_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  meal_id     uuid not null references meal_logs(id) on delete cascade,
  food_id     uuid references foods(id) on delete set null,
  recipe_id   uuid references recipes(id) on delete set null,
  -- For a recipe item: how many portions. grams is then the portion weight times this.
  portions    numeric,
  position    integer not null default 0,
  name        text not null,
  grams       numeric not null default 0,
  kcal        integer not null default 0,
  protein_g   numeric not null default 0,
  carbs_g     numeric not null default 0,
  fat_g       numeric not null default 0,
  -- Oil in the stew, sugar in the tea: listed as its own item.
  hidden      boolean not null default false,
  confidence  numeric,
  flagged     boolean not null default false,
  flag_reason text,
  -- Phase 3: each model's raw estimate, by model, beside the final numbers.
  estimates   jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

alter table meal_items add column if not exists user_id     uuid not null default auth.uid();
alter table meal_items add column if not exists food_id     uuid;
alter table meal_items add column if not exists recipe_id   uuid;
alter table meal_items add column if not exists portions    numeric;
alter table meal_items add column if not exists position    integer not null default 0;
alter table meal_items add column if not exists grams       numeric not null default 0;
alter table meal_items add column if not exists kcal        integer not null default 0;
alter table meal_items add column if not exists protein_g   numeric not null default 0;
alter table meal_items add column if not exists carbs_g     numeric not null default 0;
alter table meal_items add column if not exists fat_g       numeric not null default 0;
alter table meal_items add column if not exists hidden      boolean not null default false;
alter table meal_items add column if not exists confidence  numeric;
alter table meal_items add column if not exists flagged     boolean not null default false;
alter table meal_items add column if not exists flag_reason text;
alter table meal_items add column if not exists estimates   jsonb not null default '{}'::jsonb;
alter table meal_items add column if not exists created_at  timestamptz not null default now();

-- The caps mirror ITEM_LIMITS in src/lib/diet/nutrition.js.
alter table meal_items drop constraint if exists meal_items_ok;
alter table meal_items add  constraint meal_items_ok check (
      length(trim(name)) > 0 and length(name) <= 80
  and grams between 0 and 5000
  and kcal between 0 and 10000
  and protein_g between 0 and 1000 and carbs_g between 0 and 1000 and fat_g between 0 and 1000
  and (portions is null or (portions > 0 and portions <= 20))
  and (confidence is null or confidence between 0 and 1)
  and jsonb_typeof(estimates) = 'object'
);

create index if not exists meal_items_meal_idx on meal_items (meal_id, position);
create index if not exists meal_items_food_idx on meal_items (food_id);


-- ---------------------------------------------------------------------------
-- 4. weight_logs and pantry_items
-- ---------------------------------------------------------------------------

create table if not exists weight_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  logged_at  date not null default diet_today(),
  weight_kg  numeric not null,
  note       text,
  created_at timestamptz not null default now()
);

alter table weight_logs add column if not exists user_id    uuid not null default auth.uid();
alter table weight_logs add column if not exists logged_at  date not null default diet_today();
alter table weight_logs add column if not exists note       text;
alter table weight_logs add column if not exists created_at timestamptz not null default now();

alter table weight_logs drop constraint if exists weight_logs_range;
alter table weight_logs add  constraint weight_logs_range check (weight_kg between 30 and 400);

-- One weigh-in a day: a second on the same day replaces the first (upsert).
create unique index if not exists weight_logs_user_day_idx on weight_logs (user_id, logged_at);

create table if not exists pantry_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  name       text not null,
  quantity   numeric,
  unit       text,
  cost_naira numeric,
  bought_at  date default diet_today(),
  finished   boolean not null default false,
  food_id    uuid references foods(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table pantry_items add column if not exists user_id    uuid not null default auth.uid();
alter table pantry_items add column if not exists quantity   numeric;
alter table pantry_items add column if not exists unit       text;
alter table pantry_items add column if not exists cost_naira numeric;
alter table pantry_items add column if not exists bought_at  date default diet_today();
alter table pantry_items add column if not exists finished   boolean not null default false;
alter table pantry_items add column if not exists food_id    uuid;
alter table pantry_items add column if not exists created_at timestamptz not null default now();
alter table pantry_items add column if not exists updated_at timestamptz not null default now();

alter table pantry_items drop constraint if exists pantry_items_ok;
alter table pantry_items add  constraint pantry_items_ok check (
  length(trim(name)) > 0 and (quantity is null or quantity >= 0) and (cost_naira is null or cost_naira >= 0)
);

create index if not exists pantry_items_user_idx on pantry_items (user_id, finished, bought_at desc);


-- ---------------------------------------------------------------------------
-- 5. Row level security: the owner's rows, and only the owner's
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['diet_settings', 'foods', 'recipes', 'recipe_ingredients', 'saved_meals',
                           'meal_logs', 'meal_items', 'weight_logs', 'pantry_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_all_authenticated', t);
    execute format('create policy %I on %I for all to authenticated '
                   'using (auth.uid() = user_id) with check (auth.uid() = user_id)', t || '_all_authenticated', t);
  end loop;
end
$$;

-- The Diet screens and the Daily HQ card refresh over realtime when another
-- device logs (useRealtimeRefresh), as 042 set up for meals.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['diet_settings', 'meal_logs', 'meal_items', 'weight_logs', 'saved_meals'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
exception when others then
  raise notice 'diet: not added to supabase_realtime (%). Add the tables under Database -> Publications if live refresh is wanted.', sqlerrm;
end
$$;


-- ---------------------------------------------------------------------------
-- 6. The figures, done where the client cannot bend them
-- ---------------------------------------------------------------------------

/**
 * One portion of a recipe, unrounded: the ingredients summed by weight and
 * divided by the portions. Mirrors recipePortion in src/lib/diet/recipes.js.
 * Grams per portion is the cooked weight over portions when the pot was
 * weighed, else the raw ingredient weight over portions.
 */
create or replace function diet_recipe_portion(p_recipe_id uuid)
returns table (grams numeric, kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric)
language sql
stable
security invoker
as $$
  select coalesce(r.cooked_weight_g, sum(i.grams)) / r.portions,
         sum(f.kcal_per_100g * i.grams / 100) / r.portions,
         sum(f.protein_g * i.grams / 100) / r.portions,
         sum(f.carbs_g * i.grams / 100) / r.portions,
         sum(f.fat_g * i.grams / 100) / r.portions
    from recipes r
    join recipe_ingredients i on i.recipe_id = r.id
    join foods f on f.id = i.food_id
   where r.id = p_recipe_id
   group by r.id, r.cooked_weight_g, r.portions
$$;

revoke execute on function diet_recipe_portion(uuid) from public, anon;
grant  execute on function diet_recipe_portion(uuid) to authenticated;

/**
 * BEFORE INSERT/UPDATE on meal_items: an item that names a food or a recipe
 * gets its figures from it. On an update, only when the amount or the
 * reference changed: editing a flag must not silently re-price an old
 * item because the food's figures were corrected since.
 */
create or replace function diet_item_figures() returns trigger
language plpgsql
security invoker
as $$
declare
  f foods%rowtype;
  p record;
begin
  if tg_op = 'UPDATE'
     and new.grams is not distinct from old.grams
     and new.food_id is not distinct from old.food_id
     and new.recipe_id is not distinct from old.recipe_id
     and new.portions is not distinct from old.portions then
    return new;
  end if;

  if new.recipe_id is not null then
    select * into p from diet_recipe_portion(new.recipe_id);
    if found and p.kcal is not null then
      new.portions  := coalesce(new.portions, 1);
      new.grams     := round(p.grams * new.portions, 1);
      new.kcal      := round(p.kcal * new.portions);
      new.protein_g := round(p.protein_g * new.portions, 1);
      new.carbs_g   := round(p.carbs_g * new.portions, 1);
      new.fat_g     := round(p.fat_g * new.portions, 1);
      return new;
    end if;
  end if;

  if new.food_id is not null then
    select * into f from foods where id = new.food_id;
    if found then
      new.grams     := round(greatest(0, least(5000, coalesce(new.grams, 0))), 1);
      new.kcal      := round(f.kcal_per_100g * new.grams / 100);
      new.protein_g := round(f.protein_g * new.grams / 100, 1);
      new.carbs_g   := round(f.carbs_g * new.grams / 100, 1);
      new.fat_g     := round(f.fat_g * new.grams / 100, 1);
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists meal_items_figures on meal_items;
create trigger meal_items_figures
  before insert or update on meal_items
  for each row execute function diet_item_figures();

/**
 * BEFORE INSERT/UPDATE on meal_logs: a meal's totals are the sum of its
 * items, whatever was written. A new meal has no items yet, so it starts
 * at zero; any update (including the touch from diet_resum_meal below)
 * re-reads the items. A client writing kcal directly -- a stale screen, a
 * hand edit in the table editor -- is overruled in the same statement.
 */
create or replace function diet_logs_totals() returns trigger
language plpgsql
security invoker
as $$
begin
  if tg_op = 'INSERT' then
    new.kcal := 0;
    new.protein_g := 0;
    new.carbs_g := 0;
    new.fat_g := 0;
  else
    select coalesce(sum(kcal), 0)::integer, coalesce(sum(protein_g), 0),
           coalesce(sum(carbs_g), 0), coalesce(sum(fat_g), 0)
      into new.kcal, new.protein_g, new.carbs_g, new.fat_g
      from meal_items where meal_id = new.id;
    new.updated_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists meal_logs_totals on meal_logs;
create trigger meal_logs_totals
  before insert or update on meal_logs
  for each row execute function diet_logs_totals();

/** Re-sum one meal: touch it, and meal_logs_totals does the rest. */
create or replace function diet_resum_meal(p_meal_id uuid) returns void
language sql
security invoker
as $$
  update meal_logs set updated_at = now() where id = p_meal_id
$$;

revoke execute on function diet_resum_meal(uuid) from public, anon;
grant  execute on function diet_resum_meal(uuid) to authenticated;

/** AFTER INSERT/UPDATE/DELETE on meal_items: re-sum the meal (both meals, if an item moved). */
create or replace function diet_items_sum() returns trigger
language plpgsql
security invoker
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform diet_resum_meal(old.meal_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.meal_id is distinct from old.meal_id) then
    perform diet_resum_meal(new.meal_id);
  end if;
  return null;
end
$$;

drop trigger if exists meal_items_sum on meal_items;
create trigger meal_items_sum
  after insert or update or delete on meal_items
  for each row execute function diet_items_sum();

-- ---------------------------------------------------------------------------
-- 7. One atomic, idempotent way to log a meal
--
-- log_diet_meal(client_id, meal, items). SECURITY INVOKER, so RLS supplies
-- the owner, as log_meal (042) does. Inserts the meal and its items in one
-- transaction; the triggers above price the items and sum the meal. A
-- retry with the same client_id inserts nothing and answers "duplicate".
--
--   p_meal:  {"eaten_at": "...", "eaten_on": "YYYY-MM-DD", "meal_slot": "lunch",
--             "source": "saved", "status": "confirmed", "raw_text": null,
--             "verdict": "fits", "reason": "...", "saved_meal_id": null}
--   p_items: [{"food_id": "...", "grams": 150} | {"recipe_id": "...", "portions": 1}
--             | {"name": "Mystery stew", "grams": 300, "kcal": 420, ...}, ...]
-- ---------------------------------------------------------------------------

create or replace function log_diet_meal(p_client_id text, p_meal jsonb, p_items jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_id       uuid;
  v_count    integer;
  v_at       timestamptz := coalesce(nullif(p_meal->>'eaten_at', '')::timestamptz, now());
  v_slot     text := coalesce(nullif(trim(p_meal->>'meal_slot'), ''), 'snacks');
  v_source   text := coalesce(nullif(trim(p_meal->>'source'), ''), 'manual');
  v_status   text := coalesce(nullif(trim(p_meal->>'status'), ''), 'confirmed');
  v_verdict  text := nullif(trim(coalesce(p_meal->>'verdict', '')), '');
  v_row      meal_logs%rowtype;
begin
  if p_client_id is null or length(trim(p_client_id)) = 0 then
    raise exception 'client_id is required for idempotency';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be a JSON array';
  end if;

  select count(*) into v_count
    from jsonb_array_elements(p_items) i
   where jsonb_typeof(i) = 'object'
     and (i ? 'food_id' or i ? 'recipe_id' or length(trim(coalesce(i->>'name', ''))) > 0);
  if v_count = 0 then
    raise exception 'a meal needs at least one item';
  end if;
  if v_count > 30 then
    raise exception 'a meal holds at most 30 items, got %', v_count;
  end if;

  insert into meal_logs (client_id, eaten_at, eaten_on, meal_slot, source, status, raw_text,
                         verdict, reason, saved_meal_id)
  values (trim(p_client_id), v_at,
          coalesce(nullif(p_meal->>'eaten_on', '')::date, (v_at at time zone 'Africa/Lagos')::date),
          v_slot, v_source, v_status,
          nullif(left(trim(coalesce(p_meal->>'raw_text', '')), 1000), ''),
          v_verdict, nullif(left(trim(coalesce(p_meal->>'reason', '')), 300), ''),
          nullif(p_meal->>'saved_meal_id', '')::uuid)
  on conflict (user_id, client_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- RLS already narrows meal_logs to the caller's rows, so client_id
    -- alone finds the one row. (An explicit auth.uid() here also needs
    -- USAGE on the auth schema, which the migration harness's stubs do not
    -- grant; found by scripts/db-test.mjs.)
    select * into v_row from meal_logs where client_id = trim(p_client_id);
    return jsonb_build_object('inserted', false, 'id', v_row.id, 'kcal', v_row.kcal, 'reason', 'duplicate');
  end if;

  -- The name falls back to the food's or the recipe's; the figures are
  -- replaced by diet_item_figures whenever a food or recipe is named.
  insert into meal_items (meal_id, food_id, recipe_id, portions, position, name, grams,
                          kcal, protein_g, carbs_g, fat_g, hidden, confidence, estimates)
  select v_id,
         f.id,
         r.id,
         case when r.id is not null then coalesce(nullif(i->>'portions', '')::numeric, 1) end,
         (ord - 1)::integer,
         left(coalesce(nullif(trim(i->>'name'), ''), f.name, r.name), 80),
         round(greatest(0, least(5000, coalesce(nullif(i->>'grams', '')::numeric, 0))), 1),
         round(greatest(0, least(10000, coalesce(nullif(i->>'kcal', '')::numeric, 0)))),
         round(greatest(0, least(1000, coalesce(nullif(i->>'protein_g', '')::numeric, 0))), 1),
         round(greatest(0, least(1000, coalesce(nullif(i->>'carbs_g', '')::numeric, 0))), 1),
         round(greatest(0, least(1000, coalesce(nullif(i->>'fat_g', '')::numeric, 0))), 1),
         coalesce((i->>'hidden')::boolean, false),
         case when nullif(i->>'confidence', '') is not null
              then greatest(0, least(1, (i->>'confidence')::numeric)) end,
         case when jsonb_typeof(i->'estimates') = 'object' then i->'estimates' else '{}'::jsonb end
    from jsonb_array_elements(p_items) with ordinality as e(i, ord)
    left join foods f on f.id = nullif(i->>'food_id', '')::uuid
    left join recipes r on r.id = nullif(i->>'recipe_id', '')::uuid
   where jsonb_typeof(i) = 'object'
     and coalesce(nullif(trim(i->>'name'), ''), f.name, r.name) is not null;

  select * into v_row from meal_logs where id = v_id;
  return jsonb_build_object('inserted', true, 'id', v_id, 'kcal', v_row.kcal, 'protein_g', v_row.protein_g,
                            'carbs_g', v_row.carbs_g, 'fat_g', v_row.fat_g);
end
$$;

revoke execute on function log_diet_meal(text, jsonb, jsonb) from public, anon;
grant  execute on function log_diet_meal(text, jsonb, jsonb) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Views: a day's totals and the rolling 7-day average
--
-- security_invoker = true: the view reads the tables as the caller, so RLS
-- applies to it exactly as to meal_logs (Postgres 15+; Supabase runs 15 or
-- later). Without it a view runs as its owner and would show every row.
-- ---------------------------------------------------------------------------

create or replace view diet_daily_totals with (security_invoker = true) as
select l.user_id,
       l.eaten_on,
       count(*)::integer                                    as meals,
       sum(l.kcal)::integer                                 as kcal,
       sum(l.protein_g)                                     as protein_g,
       sum(l.carbs_g)                                       as carbs_g,
       sum(l.fat_g)                                         as fat_g,
       s.kcal_target,
       s.protein_target_g,
       (s.kcal_target - sum(l.kcal))::integer               as kcal_left,
       greatest(0, s.protein_target_g - sum(l.protein_g))   as protein_left
  from meal_logs l
  left join diet_settings s on s.user_id = l.user_id
 group by l.user_id, l.eaten_on, s.kcal_target, s.protein_target_g;

-- Over the logged days among the seven ending on each day, like
-- sevenDayAverage in src/lib/diet/totals.js: an unlogged day is a gap in
-- the record, not a day of eating nothing.
create or replace view diet_7day_average with (security_invoker = true) as
select user_id,
       eaten_on,
       count(*) over w                      as days_logged,
       round(avg(kcal) over w)::integer     as kcal,
       round(avg(protein_g) over w, 1)      as protein_g,
       round(avg(carbs_g) over w, 1)        as carbs_g,
       round(avg(fat_g) over w, 1)          as fat_g
  from diet_daily_totals
window w as (partition by user_id order by eaten_on range between interval '6 days' preceding and current row);

revoke all on diet_daily_totals, diet_7day_average from anon;
grant select on diet_daily_totals, diet_7day_average to authenticated;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  t            text;
  policy_count integer;
  test_user    uuid := gen_random_uuid();
  v_food       uuid;
  v_oil        uuid;
  v_recipe     uuid;
  v_meal       uuid;
  r            record;
  res          jsonb;
begin
  foreach t in array array['diet_settings', 'foods', 'recipes', 'recipe_ingredients', 'saved_meals',
                           'meal_logs', 'meal_items', 'weight_logs', 'pantry_items'] loop
    select count(*) into policy_count from pg_policies
     where schemaname = 'public' and tablename = t and qual like '%user_id%' and with_check like '%user_id%';
    if policy_count <> 1 then
      raise exception 'expected exactly one owner-scoped policy on %, found %', t, policy_count;
    end if;
  end loop;

  if not diet_split_ok('{"breakfast":0.2,"lunch":0.35,"dinner":0.3,"snacks":0.15}'::jsonb) then
    raise exception 'diet_split_ok refused the default split';
  end if;
  if diet_split_ok('{"breakfast":0.2,"lunch":0.35,"dinner":0.3,"snacks":0.10}'::jsonb)
     or diet_split_ok('{"breakfast":1}'::jsonb) then
    raise exception 'diet_split_ok accepted a split that is not the whole day';
  end if;

  -- The triggers, exercised as a throwaway owner whose rows are removed again.
  insert into foods (user_id, name, kcal_per_100g, protein_g, carbs_g, fat_g)
  values (test_user, '__check rice__', 130, 2.7, 28.2, 0.3) returning id into v_food;
  insert into foods (user_id, name, kcal_per_100g, fat_g)
  values (test_user, '__check oil__', 900, 100) returning id into v_oil;
  insert into recipes (user_id, name, portions) values (test_user, '__check pot__', 4) returning id into v_recipe;
  insert into recipe_ingredients (user_id, recipe_id, food_id, grams) values (test_user, v_recipe, v_food, 1000), (test_user, v_recipe, v_oil, 40);

  insert into meal_logs (user_id, client_id, meal_slot) values (test_user, '__check__', 'lunch') returning id into v_meal;
  -- A food item: the 9999 kcal sent is replaced by 250 g of rice, 325 kcal.
  insert into meal_items (user_id, meal_id, food_id, name, grams, kcal) values (test_user, v_meal, v_food, 'rice', 250, 9999);
  -- A recipe item: one portion is (1300 + 360) / 4 = 415 kcal.
  insert into meal_items (user_id, meal_id, recipe_id, portions, name) values (test_user, v_meal, v_recipe, 1, 'pot');
  -- A free item keeps its figures.
  insert into meal_items (user_id, meal_id, name, grams, kcal, protein_g) values (test_user, v_meal, 'stew', 100, 120, 3.3);

  select kcal, protein_g into r from meal_logs where id = v_meal;
  if r.kcal <> 325 + 415 + 120 then
    raise exception 'meal total should be 860 kcal (the sum of its items), got %', r.kcal;
  end if;
  -- 6.8 + 6.8 (27 g / 4 = 6.75, rounded) + 3.3
  if r.protein_g <> 16.9 then
    raise exception 'meal protein should be 16.9 g, got %', r.protein_g;
  end if;

  update meal_items set grams = 500 where meal_id = v_meal and food_id = v_food;
  select kcal into r from meal_logs where id = v_meal;
  if r.kcal <> 650 + 415 + 120 then
    raise exception 'editing grams should re-price the item and re-sum the meal, got %', r.kcal;
  end if;

  update meal_logs set kcal = 1 where id = v_meal;
  select kcal into r from meal_logs where id = v_meal;
  if r.kcal <> 1185 then
    raise exception 'a direct write to meal_logs.kcal should be refused, got %', r.kcal;
  end if;

  delete from meal_items where meal_id = v_meal and name = 'stew';
  select kcal into r from meal_logs where id = v_meal;
  if r.kcal <> 1065 then
    raise exception 'deleting an item should re-sum the meal, got %', r.kcal;
  end if;

  begin
    insert into meal_logs (user_id, client_id) values (test_user, '__check__');
    raise exception 'meal_logs accepted the same client_id twice';
  exception when unique_violation then
    null;
  end;
  begin
    insert into diet_settings (user_id, meal_split) values (test_user, '{"breakfast":1}'::jsonb);
    raise exception 'diet_settings accepted a meal split that is not the whole day';
  exception when check_violation then
    null;
  end;

  delete from meal_logs where user_id = test_user;
  delete from recipe_ingredients where user_id = test_user;
  delete from recipes where user_id = test_user;
  delete from foods where user_id = test_user;

  raise notice 'diet verified: owned tables, items priced from foods and recipes, meals summed from items';
end
$$;
