-- ============================================================================
-- 052_diet_photos.sql
--
-- Run after 051. Idempotent; safe to re-run.
--
-- The Diet module, Phase 3: photo analysis with three models
-- (docs/diet-module.md).
--
-- 1. The private storage bucket meal-photos. A photo lives at
--    <owner uuid>/<yyyy>/<mm>/<uuid>.jpg, resized to 1024 px on the long
--    side in the browser. Never public: the browser reads it through the
--    authenticated Storage API, the laptop worker through a short-lived
--    signed URL the edge function hands it. The policies let the
--    signed-in owner read, add and delete files in their own folder only.
--    This reverses 042's "the photo itself is never stored": the laptop
--    model reads the photo after the fact, which needs it kept. Photos
--    older than diet_settings.photo_retention_days are removed by
--    scripts/prune-meal-photos.mjs (weekly; nothing is removed while the
--    setting is empty).
--
-- 2. meal_estimates: one row per model per photo meal, ok or not: the
--    model's whole answer when it gave one, the reason when it did not
--    (invalid JSON twice, a timeout, a refusal, the laptop's model missing).
--    The per-item copies live in meal_items.estimates (048); this table is
--    the full record, including items no other model saw and failures,
--    which is what a later "which model comes closest" check needs. The
--    laptop worker finds its work here: a photo meal with no 'ollama' row.
--
-- 3. diet_replace_items(meal_id, items, meal): replaces a meal's items in
--    one statement and updates its slot, status, verdict and review flag.
--    Used when the owner taps "Looks right" or steps an amount (status
--    confirmed / edited) and when a late estimate re-merges a meal that is
--    still 'auto'. SECURITY INVOKER: from the browser RLS limits it to the
--    owner's meals; the edge function's service role can call it for the
--    owner's meal on the worker's behalf. The new items take the meal's
--    own user_id, so it works for both callers.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The bucket and its policies
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meal-photos', 'meal-photos', false, 2097152, array['image/jpeg', 'image/webp'])
on conflict (id) do update
   set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists meal_photos_owner_select on storage.objects;
create policy meal_photos_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists meal_photos_owner_insert on storage.objects;
create policy meal_photos_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists meal_photos_owner_delete on storage.objects;
create policy meal_photos_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);


-- ---------------------------------------------------------------------------
-- 2. meal_estimates
-- ---------------------------------------------------------------------------

create table if not exists meal_estimates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  meal_id    uuid not null references meal_logs(id) on delete cascade,
  -- claude | nvidia | ollama
  model_key  text not null,
  -- The exact model, e.g. claude-sonnet-5-5
  model_id   text,
  -- ok | invalid | error | refused | skipped
  status     text not null,
  reason     text,
  -- The validated answer (prompts/food-vision.md shape) when status is ok.
  answer     jsonb,
  latency_ms integer,
  attempts   integer not null default 1,
  created_at timestamptz not null default now()
);

alter table meal_estimates add column if not exists user_id    uuid not null default auth.uid();
alter table meal_estimates add column if not exists model_id   text;
alter table meal_estimates add column if not exists reason     text;
alter table meal_estimates add column if not exists answer     jsonb;
alter table meal_estimates add column if not exists latency_ms integer;
alter table meal_estimates add column if not exists attempts   integer not null default 1;
alter table meal_estimates add column if not exists created_at timestamptz not null default now();

alter table meal_estimates drop constraint if exists meal_estimates_ok;
alter table meal_estimates add  constraint meal_estimates_ok check (
      model_key in ('claude', 'nvidia', 'ollama')
  and status in ('ok', 'invalid', 'error', 'refused', 'skipped')
  and (status <> 'ok' or jsonb_typeof(answer) = 'object')
  and attempts between 0 and 5
);

-- One row per model per meal: a re-run replaces it (upsert), never adds a second.
create unique index if not exists meal_estimates_meal_model_idx on meal_estimates (meal_id, model_key);
create index if not exists meal_estimates_user_idx on meal_estimates (user_id, created_at desc);

alter table meal_estimates enable row level security;
drop policy if exists meal_estimates_all_authenticated on meal_estimates;
create policy meal_estimates_all_authenticated on meal_estimates
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meal_estimates') then
    alter publication supabase_realtime add table meal_estimates;
  end if;
exception when others then
  raise notice 'meal_estimates: not added to supabase_realtime (%).', sqlerrm;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. diet_replace_items
--
--   p_items: the same shape log_diet_meal takes (048, 051)
--   p_meal:  {"status": "confirmed", "meal_slot": "lunch", "verdict": "fits",
--             "reason": "...", "needs_review": false}  (each optional)
-- ---------------------------------------------------------------------------

create or replace function diet_replace_items(p_meal_id uuid, p_items jsonb, p_meal jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_meal meal_logs%rowtype;
  v_count integer;
begin
  select * into v_meal from meal_logs where id = p_meal_id;
  if not found then
    raise exception 'meal % not found', p_meal_id;
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be a JSON array';
  end if;
  select count(*) into v_count from jsonb_array_elements(p_items) i where jsonb_typeof(i) = 'object';
  if v_count = 0 then
    raise exception 'a meal needs at least one item; delete the meal instead';
  end if;
  if v_count > 30 then
    raise exception 'a meal holds at most 30 items, got %', v_count;
  end if;

  delete from meal_items where meal_id = p_meal_id;

  insert into meal_items (user_id, meal_id, food_id, recipe_id, portions, position, name, grams,
                          kcal, protein_g, carbs_g, fat_g, hidden, confidence, estimates, flagged, flag_reason)
  select v_meal.user_id,
         p_meal_id,
         f.id,
         r.id,
         case when r.id is not null then coalesce(nullif(i->>'portions', '')::numeric, 1) end,
         (ord - 1)::integer,
         left(coalesce(nullif(trim(i->>'name'), ''), f.name, r.name, 'Item'), 80),
         round(greatest(0, least(5000, coalesce(nullif(i->>'grams', '')::numeric, 0))), 1),
         round(greatest(0, least(10000, coalesce(nullif(i->>'kcal', '')::numeric, 0)))),
         round(greatest(0, least(1000, coalesce(nullif(i->>'protein_g', '')::numeric, 0))), 1),
         round(greatest(0, least(1000, coalesce(nullif(i->>'carbs_g', '')::numeric, 0))), 1),
         round(greatest(0, least(1000, coalesce(nullif(i->>'fat_g', '')::numeric, 0))), 1),
         coalesce((i->>'hidden')::boolean, false),
         case when nullif(i->>'confidence', '') is not null then greatest(0, least(1, (i->>'confidence')::numeric)) end,
         case when jsonb_typeof(i->'estimates') = 'object' then i->'estimates' else '{}'::jsonb end,
         coalesce((i->>'flagged')::boolean, false),
         nullif(left(trim(coalesce(i->>'flag_reason', '')), 200), '')
    from jsonb_array_elements(p_items) with ordinality as e(i, ord)
    left join foods f on f.id = nullif(i->>'food_id', '')::uuid and f.user_id = v_meal.user_id
    left join recipes r on r.id = nullif(i->>'recipe_id', '')::uuid and r.user_id = v_meal.user_id
   where jsonb_typeof(i) = 'object';

  update meal_logs
     set status       = coalesce(nullif(p_meal->>'status', ''), status),
         meal_slot    = coalesce(nullif(p_meal->>'meal_slot', ''), meal_slot),
         verdict      = case when p_meal ? 'verdict' then nullif(p_meal->>'verdict', '') else verdict end,
         reason       = case when p_meal ? 'reason' then nullif(left(p_meal->>'reason', 300), '') else reason end,
         needs_review = coalesce((p_meal->>'needs_review')::boolean,
                                 exists (select 1 from meal_items where meal_id = p_meal_id and flagged))
   where id = p_meal_id;

  select * into v_meal from meal_logs where id = p_meal_id;
  return jsonb_build_object('id', v_meal.id, 'status', v_meal.status, 'kcal', v_meal.kcal, 'protein_g', v_meal.protein_g);
end
$$;

revoke execute on function diet_replace_items(uuid, jsonb, jsonb) from public, anon;
grant  execute on function diet_replace_items(uuid, jsonb, jsonb) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  n integer;
begin
  if not exists (select 1 from storage.buckets where id = 'meal-photos' and public = false) then
    raise exception 'meal-photos bucket missing or public';
  end if;
  select count(*) into n from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'meal_photos_owner_%';
  if n <> 3 then
    raise exception 'expected 3 meal-photos policies on storage.objects, found %', n;
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'meal_estimates' and qual like '%user_id%' and with_check like '%user_id%';
  if n <> 1 then
    raise exception 'expected exactly one owner-scoped policy on meal_estimates, found %', n;
  end if;
  raise notice 'diet photos verified: private bucket, owner-only folders, meal_estimates owned';
end
$$;
