-- ============================================================================
-- 051_diet_pantry.sql
--
-- Run after 050. Idempotent; safe to re-run.
--
-- The Diet module, Phase 2: text and voice (docs/diet-module.md).
--
-- 1. pantry_events: one row per pantry update the owner confirmed ("bought
--    2 kg beans for 3,000", "eggs finished"), with what it changed. It is
--    the idempotency ledger -- unique on (owner, client id, position) -- so
--    a retry after dropped mobile data applies nothing twice; and it is the
--    history of what was bought for how much, which the coach (Phase 4)
--    and a later food-spend view can read.
--
-- 2. apply_pantry_updates(client_id, updates): applies the updates from the
--    text parser in one transaction. SECURITY INVOKER, so RLS supplies the
--    owner, as log_diet_meal (048) does.
--      bought    inserts a pantry_items row
--      finished  marks every open row of that food (by food_id, else name) finished
--      used      takes the quantity off the newest open row with a quantity,
--                and marks it finished at zero; without a quantity it is
--                recorded and changes nothing
--
-- 3. log_diet_meal, replaced with the same signature: it now also stores
--    each item's flagged / flag_reason (the parser flags items not in the
--    foods list and guessed amounts) and sets meal_logs.needs_review when
--    any item is flagged. Everything else is as 048 wrote it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. pantry_events
-- ---------------------------------------------------------------------------

create table if not exists pantry_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid(),
  client_id      text not null,
  position       integer not null default 0,
  action         text not null,
  name           text not null,
  food_id        uuid references foods(id) on delete set null,
  quantity       numeric,
  unit           text,
  cost_naira     numeric,
  -- What it did: 'added', 'finished', 'reduced', 'recorded' (nothing to change)
  outcome        text not null default 'recorded',
  pantry_item_id uuid references pantry_items(id) on delete set null,
  raw_text       text,
  created_at     timestamptz not null default now()
);

alter table pantry_events add column if not exists user_id        uuid not null default auth.uid();
alter table pantry_events add column if not exists position       integer not null default 0;
alter table pantry_events add column if not exists food_id        uuid;
alter table pantry_events add column if not exists quantity       numeric;
alter table pantry_events add column if not exists unit           text;
alter table pantry_events add column if not exists cost_naira     numeric;
alter table pantry_events add column if not exists outcome        text not null default 'recorded';
alter table pantry_events add column if not exists pantry_item_id uuid;
alter table pantry_events add column if not exists raw_text       text;
alter table pantry_events add column if not exists created_at     timestamptz not null default now();

alter table pantry_events drop constraint if exists pantry_events_ok;
alter table pantry_events add  constraint pantry_events_ok check (
      length(trim(client_id)) > 0
  and length(trim(name)) > 0
  and action in ('bought', 'finished', 'used')
  and outcome in ('added', 'finished', 'reduced', 'recorded')
  and (quantity is null or quantity > 0)
  and (cost_naira is null or cost_naira >= 0)
);

create unique index if not exists pantry_events_user_client_idx on pantry_events (user_id, client_id, position);
create index if not exists pantry_events_user_time_idx on pantry_events (user_id, created_at desc);

alter table pantry_events enable row level security;
drop policy if exists pantry_events_all_authenticated on pantry_events;
create policy pantry_events_all_authenticated on pantry_events
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 2. apply_pantry_updates
--
--   p_updates: [{"action": "bought", "name": "beans", "food_id": "...",
--                "quantity": 2, "unit": "kg", "cost_naira": 3000}, ...]
-- ---------------------------------------------------------------------------

create or replace function apply_pantry_updates(p_client_id text, p_updates jsonb, p_raw_text text default null)
returns jsonb
language plpgsql
security invoker
as $$
declare
  u         jsonb;
  pos       integer := 0;
  v_action  text;
  v_name    text;
  v_food    uuid;
  v_qty     numeric;
  v_item    uuid;
  v_outcome text;
  v_event   uuid;
  v_left    numeric;
  results   jsonb := '[]'::jsonb;
  applied   integer := 0;
  repeated  integer := 0;
begin
  if p_client_id is null or length(trim(p_client_id)) = 0 then
    raise exception 'client_id is required for idempotency';
  end if;
  if p_updates is null or jsonb_typeof(p_updates) <> 'array' then
    raise exception 'updates must be a JSON array';
  end if;
  if jsonb_array_length(p_updates) > 20 then
    raise exception 'at most 20 pantry updates at once, got %', jsonb_array_length(p_updates);
  end if;

  for u in select value from jsonb_array_elements(p_updates) loop
    pos := pos + 1;
    v_action := nullif(trim(coalesce(u->>'action', '')), '');
    v_name := left(nullif(trim(regexp_replace(coalesce(u->>'name', ''), '\s+', ' ', 'g')), ''), 80);
    if v_action is null or v_action not in ('bought', 'finished', 'used') or v_name is null then
      raise exception 'update % needs an action (bought, finished, used) and a name', pos;
    end if;
    -- Only a food the caller can see (RLS) is linked.
    select id into v_food from foods where id = nullif(u->>'food_id', '')::uuid;
    v_qty := nullif(u->>'quantity', '')::numeric;
    if v_qty is not null and v_qty <= 0 then
      v_qty := null;
    end if;

    -- The ledger row first: a repeat of the same client id and position
    -- conflicts here and applies nothing.
    insert into pantry_events (client_id, position, action, name, food_id, quantity, unit, cost_naira, raw_text)
    values (trim(p_client_id), pos, v_action, v_name, v_food, v_qty,
            left(nullif(trim(coalesce(u->>'unit', '')), ''), 20),
            greatest(0, nullif(u->>'cost_naira', '')::numeric),
            left(nullif(trim(coalesce(p_raw_text, '')), ''), 500))
    on conflict (user_id, client_id, position) do nothing
    returning id into v_event;

    if v_event is null then
      repeated := repeated + 1;
      results := results || jsonb_build_object('position', pos, 'action', v_action, 'outcome', 'duplicate');
      continue;
    end if;

    v_item := null;
    v_outcome := 'recorded';

    if v_action = 'bought' then
      insert into pantry_items (name, quantity, unit, cost_naira, food_id)
      values (v_name, v_qty, left(nullif(trim(coalesce(u->>'unit', '')), ''), 20),
              greatest(0, nullif(u->>'cost_naira', '')::numeric), v_food)
      returning id into v_item;
      v_outcome := 'added';

    elsif v_action = 'finished' then
      with done as (
        update pantry_items p
           set finished = true, updated_at = now()
         where not p.finished
           and ((v_food is not null and p.food_id = v_food) or lower(p.name) = lower(v_name))
        returning p.id
      )
      select id into v_item from done limit 1;
      if v_item is not null then
        v_outcome := 'finished';
      end if;

    elsif v_action = 'used' and v_qty is not null then
      select id, quantity - v_qty into v_item, v_left
        from pantry_items p
       where not p.finished and p.quantity is not null
         and ((v_food is not null and p.food_id = v_food) or lower(p.name) = lower(v_name))
       order by p.bought_at desc nulls last, p.created_at desc
       limit 1;
      if v_item is not null then
        update pantry_items
           set quantity = greatest(0, v_left), finished = (v_left <= 0), updated_at = now()
         where id = v_item;
        v_outcome := case when v_left <= 0 then 'finished' else 'reduced' end;
      end if;
    end if;

    update pantry_events set outcome = v_outcome, pantry_item_id = v_item where id = v_event;
    applied := applied + 1;
    results := results || jsonb_build_object('position', pos, 'action', v_action, 'outcome', v_outcome, 'pantry_item_id', v_item);
  end loop;

  return jsonb_build_object('applied', applied, 'duplicates', repeated, 'results', results);
end
$$;

revoke execute on function apply_pantry_updates(text, jsonb, text) from public, anon;
grant  execute on function apply_pantry_updates(text, jsonb, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. log_diet_meal, now carrying the parser's flags
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
                         verdict, reason, saved_meal_id, needs_review)
  values (trim(p_client_id), v_at,
          coalesce(nullif(p_meal->>'eaten_on', '')::date, (v_at at time zone 'Africa/Lagos')::date),
          v_slot, v_source, v_status,
          nullif(left(trim(coalesce(p_meal->>'raw_text', '')), 1000), ''),
          v_verdict, nullif(left(trim(coalesce(p_meal->>'reason', '')), 300), ''),
          nullif(p_meal->>'saved_meal_id', '')::uuid,
          exists (select 1 from jsonb_array_elements(p_items) i
                   where jsonb_typeof(i) = 'object' and coalesce((i->>'flagged')::boolean, false)))
  on conflict (user_id, client_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- RLS already narrows meal_logs to the caller's rows (see 048).
    select * into v_row from meal_logs where client_id = trim(p_client_id);
    return jsonb_build_object('inserted', false, 'id', v_row.id, 'kcal', v_row.kcal, 'reason', 'duplicate');
  end if;

  insert into meal_items (meal_id, food_id, recipe_id, portions, position, name, grams,
                          kcal, protein_g, carbs_g, fat_g, hidden, confidence, estimates,
                          flagged, flag_reason)
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
         case when jsonb_typeof(i->'estimates') = 'object' then i->'estimates' else '{}'::jsonb end,
         coalesce((i->>'flagged')::boolean, false),
         nullif(left(trim(coalesce(i->>'flag_reason', '')), 200), '')
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
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  policy_count integer;
begin
  select count(*) into policy_count from pg_policies
   where schemaname = 'public' and tablename = 'pantry_events' and qual like '%user_id%' and with_check like '%user_id%';
  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on pantry_events, found %', policy_count;
  end if;
  if not exists (select 1 from pg_proc where proname = 'apply_pantry_updates') then
    raise exception 'apply_pantry_updates is missing';
  end if;
  raise notice 'diet pantry verified: pantry_events owned, apply_pantry_updates in place';
end
$$;
