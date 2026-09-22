-- ============================================================================
-- 027_repairs.sql
--
-- Run after 026. Idempotent; safe to re-run.
--
-- The last of the README's five modules. Like `projects` in 026, a
-- hand-made `repairs` table already exists live -- `item`, `classification`
-- (need/want), `estimated_cost`, `priority` (urgent/soon/someday), `status`
-- (pending/in-progress/done), `notes` -- with no owner and the 015 lock.
-- Same treatment: keep the shape and its spellings, add what the app
-- needs, claim any rows by 014's rule, require an owner, replace the lock.
-- ============================================================================

create table if not exists repairs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid,
  item            text not null,
  classification  text,
  estimated_cost  numeric,
  priority        text,
  status          text default 'pending',
  due_date        date,
  notes           text,
  completed_at    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 1. Heal the shape
-- ---------------------------------------------------------------------------

alter table repairs add column if not exists user_id        uuid;
alter table repairs add column if not exists item           text;
alter table repairs add column if not exists classification text;
alter table repairs add column if not exists estimated_cost numeric;
alter table repairs add column if not exists priority       text;
alter table repairs add column if not exists status         text default 'pending';
alter table repairs add column if not exists due_date       date;
alter table repairs add column if not exists notes          text;
alter table repairs add column if not exists completed_at   timestamptz;
alter table repairs add column if not exists created_at     timestamptz default now();
alter table repairs add column if not exists updated_at     timestamptz not null default now();

update repairs set status     = 'pending' where status is null;
update repairs set priority   = 'soon'    where priority is null;
update repairs set created_at = now()     where created_at is null;
alter table repairs alter column status     set not null;
alter table repairs alter column priority   set not null;
alter table repairs alter column priority   set default 'soon';
alter table repairs alter column created_at set not null;

do $$
declare
  foreign_required text;
begin
  select string_agg(column_name, ', ' order by ordinal_position)
    into foreign_required
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'repairs'
     and is_nullable = 'NO'
     and column_default is null
     and column_name not in ('id', 'user_id', 'item', 'status', 'priority', 'created_at', 'updated_at');

  if foreign_required is not null then
    raise exception
      'public.repairs has required column(s) this migration does not manage: %', foreign_required
      using hint = 'Make them nullable or give them defaults, then re-run.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. Claim any existing rows, then require an owner (014's rule)
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id   uuid;
  user_count integer;
  unowned    integer;
begin
  select count(*) into unowned from repairs where user_id is null;

  if unowned > 0 then
    begin
      owner_id := nullif(current_setting('jare.owner', true), '')::uuid;
    exception when others then
      raise exception 'jare.owner is set but is not a uuid: %', current_setting('jare.owner', true);
    end;

    if owner_id is null then
      select count(*) into user_count from auth.users;
      if user_count = 0 then
        raise exception 'repairs holds unowned rows and auth.users is empty. Sign in once, then re-run.';
      elsif user_count > 1 then
        raise exception 'repairs holds unowned rows and auth.users holds % accounts. Re-run with: set local jare.owner = ''<uuid>'';', user_count;
      end if;
      select id into owner_id from auth.users;
    end if;

    update repairs set user_id = owner_id where user_id is null;
    raise notice 'claimed % unowned repair row(s) for %', unowned, owner_id;
  end if;
end
$$;

alter table repairs alter column user_id set not null;
alter table repairs alter column user_id set default auth.uid();


-- ---------------------------------------------------------------------------
-- 3. Constraints -- the hand-made spellings, recreated by name
-- ---------------------------------------------------------------------------

alter table repairs drop constraint if exists repairs_classification_check;
alter table repairs add  constraint repairs_classification_check
  check (classification is null or classification in ('need', 'want'));

alter table repairs drop constraint if exists repairs_priority_check;
alter table repairs add  constraint repairs_priority_check
  check (priority in ('urgent', 'soon', 'someday'));

alter table repairs drop constraint if exists repairs_status_check;
alter table repairs add  constraint repairs_status_check
  check (status in ('pending', 'in-progress', 'done'));

alter table repairs drop constraint if exists repairs_item_not_blank;
alter table repairs add  constraint repairs_item_not_blank
  check (length(trim(item)) > 0);

alter table repairs drop constraint if exists repairs_cost_nonneg;
alter table repairs add  constraint repairs_cost_nonneg
  check (estimated_cost is null or estimated_cost >= 0);

create index if not exists repairs_user_status_idx on repairs (user_id, status);


-- ---------------------------------------------------------------------------
-- 4. Ownership replaces the lock 015 put on
-- ---------------------------------------------------------------------------

alter table repairs enable row level security;

drop policy if exists repairs_no_access on repairs;
drop policy if exists repairs_all_authenticated on repairs;
create policy repairs_all_authenticated on repairs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 5. Verify
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col  text;
  policy_count integer;
  test_user    uuid := gen_random_uuid();
begin
  select string_agg(c, ', ')
    into missing_col
    from unnest(array['user_id','item','classification','estimated_cost','priority','status','due_date','notes','completed_at','updated_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'repairs' and column_name = c
   );
  if missing_col is not null then
    raise exception 'repairs is missing column(s): %', missing_col;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'repairs'
       and column_name = 'user_id' and is_nullable = 'YES'
  ) then
    raise exception 'repairs.user_id must be NOT NULL';
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'repairs' and policyname = 'repairs_no_access') then
    raise exception 'the 015 lock is still on';
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'repairs'
     and qual like '%user_id%' and with_check like '%user_id%';
  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on repairs, found %', policy_count;
  end if;

  insert into repairs (user_id, item, priority, estimated_cost) values (test_user, '__check__', 'urgent', 15000);

  begin
    insert into repairs (user_id, item, priority) values (test_user, 'x', 'whenever');
    raise exception 'repairs_priority_check accepted an unknown priority';
  exception when check_violation then
    null;
  end;

  begin
    insert into repairs (user_id, item, estimated_cost) values (test_user, 'x', -1);
    raise exception 'repairs_cost_nonneg accepted a negative estimate';
  exception when check_violation then
    null;
  end;

  delete from repairs where user_id = test_user;

  raise notice 'repairs verified: owned, checked, RLS on';
end
$$;
