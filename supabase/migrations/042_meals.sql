-- ============================================================================
-- 042_meals.sql
--
-- Run after 041. Idempotent; safe to re-run.
--
-- Meals: what the owner ate, logged from a photo (or a sentence) through
-- the analyze-meal edge function, with the calories the model estimated and
-- the owner adjusted. One row per meal; the dishes live in `items`, a JSON
-- array in the shape src/lib/meals.js produces:
--
--   [{"name": "Jollof rice", "portion": "2 cups", "grams": 400,
--     "calories": 600, "protein_g": 12, "carbs_g": 110, "fat_g": 14,
--     "confidence": "high", "note": null, "quantity": 1}, ...]
--
-- The photo itself is never stored: the free tier has no room for it and
-- the row needs only the reading. A thumbnail of a few kilobytes may ride
-- along so the list is recognisable.
--
-- Same shape as 031: small, owner-owned, RLS `auth.uid() = user_id` from the
-- first version. Writes go through log_meal, which is idempotent on a
-- client-minted id exactly like log_manual_transaction (002): a retry after
-- dropped mobile data inserts nothing. The function recomputes the calorie
-- total from the items itself, so the figure in `calories` is always the
-- sum of the rows under it, whatever the client sent.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table if not exists meals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  -- Minted by the client when the capture sheet opens; the idempotency key.
  client_id   text not null,
  eaten_on    date not null default current_date,
  eaten_at    time,
  meal_type   text not null default 'snack',
  items       jsonb not null default '[]'::jsonb,
  -- Kilocalories, recomputed by log_meal from items.
  calories    integer not null default 0,
  protein_g   numeric,
  carbs_g     numeric,
  fat_g       numeric,
  -- 'photo' | 'text' | 'manual' | 'repeat'
  source      text not null default 'photo',
  -- Which model answered, for the day a figure looks wrong.
  provider    text,
  model       text,
  -- The photo-quality report (lighting, correction applied, model's own view).
  quality     jsonb,
  note        text,
  -- A data: URL of at most a few kilobytes, or null.
  thumbnail   text,
  created_at  timestamptz not null default now()
);

alter table meals add column if not exists user_id    uuid not null default auth.uid();
alter table meals add column if not exists client_id  text;
alter table meals add column if not exists eaten_on   date not null default current_date;
alter table meals add column if not exists eaten_at   time;
alter table meals add column if not exists meal_type  text not null default 'snack';
alter table meals add column if not exists items      jsonb not null default '[]'::jsonb;
alter table meals add column if not exists calories   integer not null default 0;
alter table meals add column if not exists protein_g  numeric;
alter table meals add column if not exists carbs_g    numeric;
alter table meals add column if not exists fat_g      numeric;
alter table meals add column if not exists source     text not null default 'photo';
alter table meals add column if not exists provider   text;
alter table meals add column if not exists model      text;
alter table meals add column if not exists quality    jsonb;
alter table meals add column if not exists note       text;
alter table meals add column if not exists thumbnail  text;
alter table meals add column if not exists created_at timestamptz not null default now();

alter table meals drop constraint if exists meals_client_id_not_blank;
alter table meals add  constraint meals_client_id_not_blank check (length(trim(client_id)) > 0);

alter table meals drop constraint if exists meals_meal_type_check;
alter table meals add  constraint meals_meal_type_check
  check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack'));

alter table meals drop constraint if exists meals_source_check;
alter table meals add  constraint meals_source_check
  check (source in ('photo', 'text', 'manual', 'repeat'));

alter table meals drop constraint if exists meals_items_is_array;
alter table meals add  constraint meals_items_is_array check (jsonb_typeof(items) = 'array');

alter table meals drop constraint if exists meals_calories_range;
alter table meals add  constraint meals_calories_range check (calories >= 0 and calories <= 8000);

-- A thumbnail is a convenience, never a photo store.
alter table meals drop constraint if exists meals_thumbnail_small;
alter table meals add  constraint meals_thumbnail_small
  check (thumbnail is null or (length(thumbnail) <= 8000 and thumbnail like 'data:image/%'));

-- What log_meal conflicts on.
create unique index if not exists meals_user_client_idx on meals (user_id, client_id);
-- The page reads one day, and the week strip reads seven, newest first.
create index if not exists meals_user_day_idx on meals (user_id, eaten_on desc, created_at desc);

alter table meals enable row level security;

drop policy if exists meals_all_authenticated on meals;
create policy meals_all_authenticated on meals
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The Meals page and the Daily HQ card refresh over realtime when another
-- device logs (useRealtimeRefresh). The other tables were added to the
-- publication from the dashboard; this one adds itself, and shrugs when
-- the publication is not there (a fresh project before realtime is on).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meals') then
    alter publication supabase_realtime add table meals;
  end if;
exception when others then
  raise notice 'meals: not added to supabase_realtime (%). Add it under Database -> Publications if live refresh is wanted.', sqlerrm;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The sum, done where the client cannot bend it
--
-- Mirrors sumCalories/itemCalories in src/lib/meals.js: each item is its
-- calories times its quantity (default 1), rounded, floored at zero and
-- capped at 3000; the meal is capped at 8000. An item without a numeric
-- calorie figure counts as zero rather than failing the whole meal.
-- ---------------------------------------------------------------------------

create or replace function jare_meal_calories(p_items jsonb) returns integer
language sql
immutable
as $$
  select coalesce(least(8000, sum(
    least(3000, greatest(0, round(
      coalesce(nullif(regexp_replace(i->>'calories', '[^0-9.\-]', '', 'g'), '')::numeric, 0)
      * least(10, greatest(0.25, coalesce(nullif(regexp_replace(i->>'quantity', '[^0-9.]', '', 'g'), '')::numeric, 1)))
    )))
  ))::integer, 0)
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as i
  where jsonb_typeof(i) = 'object';
$$;

revoke execute on function jare_meal_calories(jsonb) from public, anon;
grant  execute on function jare_meal_calories(jsonb) to authenticated;

/** One macro, summed the same way; null when no item carries it. */
create or replace function jare_meal_macro(p_items jsonb, p_key text) returns numeric
language sql
immutable
as $$
  select round(sum(
    nullif(regexp_replace(i->>p_key, '[^0-9.]', '', 'g'), '')::numeric
    * least(10, greatest(0.25, coalesce(nullif(regexp_replace(i->>'quantity', '[^0-9.]', '', 'g'), '')::numeric, 1)))
  ), 1)
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as i
  where jsonb_typeof(i) = 'object'
    and nullif(regexp_replace(i->>p_key, '[^0-9.]', '', 'g'), '') is not null;
$$;

revoke execute on function jare_meal_macro(jsonb, text) from public, anon;
grant  execute on function jare_meal_macro(jsonb, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. One atomic, idempotent entry point
--
-- SECURITY INVOKER: RLS supplies user_id (the default) and refuses a row for
-- anyone else, so the function adds no filtering of its own. Returns JSON
-- rather than raising for a duplicate, like ingest_alert_transaction, so a
-- retry reads as "already there" and not as an error toast.
-- ---------------------------------------------------------------------------

create or replace function log_meal(
  p_client_id text,
  p_items     jsonb,
  p_eaten_on  date default null,
  p_eaten_at  time default null,
  p_meal_type text default null,
  p_note      text default null,
  p_source    text default 'photo',
  p_provider  text default null,
  p_model     text default null,
  p_quality   jsonb default null,
  p_thumbnail text default null
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_items    jsonb;
  v_count    integer;
  v_id       uuid;
  v_calories integer;
  v_type     text := coalesce(nullif(trim(p_meal_type), ''), 'snack');
  v_source   text := coalesce(nullif(trim(p_source), ''), 'photo');
begin
  if p_client_id is null or length(trim(p_client_id)) = 0 then
    raise exception 'client_id is required for idempotency';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be a JSON array';
  end if;

  -- Keep only objects with a name, at most twelve, trimmed to the keys the
  -- app reads. Anything else the model or a stale client sent is dropped
  -- here rather than stored for ever.
  select coalesce(jsonb_agg(jsonb_build_object(
           'name',       left(trim(i->>'name'), 60),
           'portion',    left(coalesce(i->>'portion', ''), 40),
           'grams',      nullif(regexp_replace(i->>'grams', '[^0-9.]', '', 'g'), '')::numeric,
           'calories',   least(3000, greatest(0, round(coalesce(nullif(regexp_replace(i->>'calories', '[^0-9.\-]', '', 'g'), '')::numeric, 0)))),
           'protein_g',  nullif(regexp_replace(i->>'protein_g', '[^0-9.]', '', 'g'), '')::numeric,
           'carbs_g',    nullif(regexp_replace(i->>'carbs_g', '[^0-9.]', '', 'g'), '')::numeric,
           'fat_g',      nullif(regexp_replace(i->>'fat_g', '[^0-9.]', '', 'g'), '')::numeric,
           'confidence', case when i->>'confidence' in ('high', 'medium', 'low') then i->>'confidence' else 'medium' end,
           'note',       nullif(left(trim(coalesce(i->>'note', '')), 120), ''),
           'quantity',   least(10, greatest(0.25, coalesce(nullif(regexp_replace(i->>'quantity', '[^0-9.]', '', 'g'), '')::numeric, 1)))
         )), '[]'::jsonb), count(*)
    into v_items, v_count
    from (
      select i from jsonb_array_elements(p_items) as i
       where jsonb_typeof(i) = 'object' and length(trim(coalesce(i->>'name', ''))) > 0
       limit 12
    ) s;

  if v_count = 0 then
    raise exception 'a meal needs at least one named item';
  end if;
  if v_type not in ('breakfast', 'lunch', 'dinner', 'snack') then
    raise exception 'meal_type must be breakfast, lunch, dinner or snack, got %', v_type;
  end if;
  if v_source not in ('photo', 'text', 'manual', 'repeat') then
    raise exception 'source must be photo, text, manual or repeat, got %', v_source;
  end if;

  v_calories := jare_meal_calories(v_items);

  insert into meals
    (client_id, eaten_on, eaten_at, meal_type, items, calories,
     protein_g, carbs_g, fat_g, source, provider, model, quality, note, thumbnail)
  values
    (trim(p_client_id), coalesce(p_eaten_on, current_date), p_eaten_at, v_type, v_items, v_calories,
     jare_meal_macro(v_items, 'protein_g'), jare_meal_macro(v_items, 'carbs_g'), jare_meal_macro(v_items, 'fat_g'),
     v_source, nullif(left(trim(coalesce(p_provider, '')), 40), ''), nullif(left(trim(coalesce(p_model, '')), 80), ''),
     p_quality, nullif(left(trim(coalesce(p_note, '')), 200), ''),
     case when p_thumbnail like 'data:image/%' and length(p_thumbnail) <= 8000 then p_thumbnail end)
  on conflict (user_id, client_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id, calories into v_id, v_calories from meals
     where user_id = auth.uid() and client_id = trim(p_client_id);
    return jsonb_build_object('inserted', false, 'id', v_id, 'calories', v_calories, 'reason', 'duplicate');
  end if;

  return jsonb_build_object('inserted', true, 'id', v_id, 'calories', v_calories, 'items', v_count);
end
$$;

revoke execute on function log_meal(text, jsonb, date, time, text, text, text, text, text, jsonb, text) from public, anon;
grant  execute on function log_meal(text, jsonb, date, time, text, text, text, text, text, jsonb, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col  text;
  policy_count integer;
  test_user    uuid := gen_random_uuid();
  dup_refused  boolean := false;
  n            integer;
begin
  select string_agg(c, ', ') into missing_col
    from unnest(array['user_id','client_id','eaten_on','eaten_at','meal_type','items','calories',
                      'protein_g','carbs_g','fat_g','source','provider','model','quality','note','thumbnail','created_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'meals' and column_name = c);
  if missing_col is not null then
    raise exception 'meals is missing column(s): %', missing_col;
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'meals'
     and qual like '%user_id%' and with_check like '%user_id%';
  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on meals, found %', policy_count;
  end if;

  -- The sum: quantity applied, a nameless or absurd item tamed, the caps held.
  n := jare_meal_calories('[{"name":"Akara","calories":80,"quantity":3},{"name":"Coke","calories":"210"},{"calories":999},{"name":"Nkwobi","calories":99999}]'::jsonb);
  if n <> 240 + 210 + 999 + 3000 then
    raise exception 'jare_meal_calories: expected 4449, got %', n;
  end if;
  if jare_meal_calories('[]'::jsonb) <> 0 or jare_meal_calories('"nope"'::jsonb) <> 0 then
    raise exception 'jare_meal_calories: empty or non-array input should be 0';
  end if;
  if jare_meal_calories('[{"calories":3000},{"calories":3000},{"calories":3000}]'::jsonb) <> 8000 then
    raise exception 'jare_meal_calories: the 8000 kcal meal cap did not hold';
  end if;
  if jare_meal_macro('[{"protein_g":10,"quantity":2},{"protein_g":"abc"}]'::jsonb, 'protein_g') <> 20 then
    raise exception 'jare_meal_macro: expected 20';
  end if;
  if jare_meal_macro('[{"calories":100}]'::jsonb, 'protein_g') is not null then
    raise exception 'jare_meal_macro: should be null when no item carries the macro';
  end if;

  -- The table: one row per client id per owner, and the constraints bite.
  insert into meals (user_id, client_id, items, calories) values (test_user, 'c-1', '[]'::jsonb, 0);
  begin
    insert into meals (user_id, client_id, items, calories) values (test_user, 'c-1', '[]'::jsonb, 0);
  exception when unique_violation then
    dup_refused := true;
  end;
  begin
    insert into meals (user_id, client_id, meal_type) values (test_user, 'c-2', 'brunch');
    raise exception 'meals accepted meal_type brunch';
  exception when check_violation then
    null;
  end;
  begin
    insert into meals (user_id, client_id, thumbnail) values (test_user, 'c-3', 'https://example.com/x.jpg');
    raise exception 'meals accepted a thumbnail that is not a data URL';
  exception when check_violation then
    null;
  end;
  delete from meals where user_id = test_user;

  if not dup_refused then
    raise exception 'meals accepted the same client_id twice for one owner';
  end if;

  raise notice 'meals verified: owned, one row per client id, calories summed in the database';
end
$$;
