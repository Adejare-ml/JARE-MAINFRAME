-- ============================================================================
-- 054_photo_meal_lock.sql
--
-- Run after 053. Idempotent; safe to re-run.
--
-- A photo meal is the model's reading, not the owner's. The owner asked
-- for the photo to be the point of honesty: once the model has read the
-- plate, the numbers go into the log as they are, and nobody, the owner
-- included, can talk them down afterwards.
--
-- So a photo meal is "sealed" as soon as diet-photo has logged it (status
-- 'confirmed', set by the edge function's service role), and for the
-- signed-in owner (role authenticated):
--
--   meal_items of a sealed photo meal: no insert, update or delete
--   meal_logs of a sealed photo meal:  no delete; no change to source,
--                                      eaten_at, eaten_on or status
--   meal_logs of an unsealed one ('auto', left by the old flow): the only
--                                      status change allowed is to 'confirmed'
--
-- Slot, verdict, reason, coach and needs_review stay writable: none of
-- them changes a calorie. The edge functions' service role is not held to
-- this (it seals the meal, and the laptop worker attaches its estimates
-- beside the items), nor is the table editor (role postgres).
--
-- kcal and the macros on meal_logs need no rule of their own: 048's
-- meal_logs_totals trigger always re-sums them from the items.
-- ============================================================================

create or replace function diet_photo_sealed(p_meal_id uuid) returns boolean
language sql
stable
security invoker
as $$
  select exists (select 1 from meal_logs where id = p_meal_id and source = 'photo' and status <> 'auto')
$$;

revoke execute on function diet_photo_sealed(uuid) from public, anon;
grant  execute on function diet_photo_sealed(uuid) to authenticated, service_role;

create or replace function diet_photo_items_lock() returns trigger
language plpgsql
security invoker
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if (tg_op in ('UPDATE', 'DELETE') and diet_photo_sealed(old.meal_id))
     or (tg_op in ('INSERT', 'UPDATE') and diet_photo_sealed(new.meal_id)) then
    raise exception 'a photo meal is the model''s reading and cannot be changed'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end
$$;

drop trigger if exists meal_items_photo_lock on meal_items;
create trigger meal_items_photo_lock
  before insert or update or delete on meal_items
  for each row execute function diet_photo_items_lock();

create or replace function diet_photo_logs_lock() returns trigger
language plpgsql
security invoker
as $$
begin
  if current_user <> 'authenticated' or old.source <> 'photo' then
    return coalesce(new, old);
  end if;
  if old.status = 'auto' then
    -- The old flow's unchecked meals: the owner may only accept them.
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status <> 'confirmed' then
      raise exception 'an unchecked photo meal cannot be changed, only confirmed'
        using errcode = 'check_violation';
    end if;
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a photo meal is the model''s reading and cannot be deleted'
      using errcode = 'check_violation';
  end if;
  if new.source is distinct from old.source
     or new.status is distinct from old.status
     or new.eaten_at is distinct from old.eaten_at
     or new.eaten_on is distinct from old.eaten_on then
    raise exception 'a photo meal is the model''s reading and cannot be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

drop trigger if exists meal_logs_photo_lock on meal_logs;
create trigger meal_logs_photo_lock
  before update or delete on meal_logs
  for each row execute function diet_photo_logs_lock();

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'meal_items_photo_lock' and not tgisinternal) then
    raise exception 'meal_items_photo_lock is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'meal_logs_photo_lock' and not tgisinternal) then
    raise exception 'meal_logs_photo_lock is missing';
  end if;
  raise notice 'photo meal lock verified: both triggers in place';
end
$$;
