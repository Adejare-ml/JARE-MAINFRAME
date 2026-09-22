-- ============================================================================
-- 026_projects.sql
--
-- Run after 025. Idempotent; safe to re-run.
--
-- The README promised "budgeting, goals, projects, debts and repairs"; the
-- Projects page has been a placeholder since the first commit. Two tables
-- for it -- `projects` and `milestones` -- already exist in the live
-- database, made by hand in the dashboard before any code used them, with
-- no `user_id`, no migration, and (since 015) a policy that lets nobody in.
-- 015 was right not to invent ownership for tables nothing populated. This
-- is the migration that populates them, so it heals them the way 004 healed
-- `debts`: keep the hand-built shape and its column names (`name`, `type`,
-- `status`, `stack`, `done_criteria`, `outcome_note`; a milestone row per
-- milestone, cascading with its project), add what the app needs, claim any
-- rows the way 014 does, then tighten. A fresh database gets the same shape
-- from the CREATEs alone.
-- ============================================================================

create table if not exists projects (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid,
  month          date not null,
  name           text not null,
  description    text,
  type           text,
  stack          text,
  done_criteria  text,
  status         text default 'active',
  outcome_note   text,
  -- Where a carried-over project came from, so "Carried Over" is a fact on
  -- the row rather than a status you lose the moment you mark it active.
  carried_from   date,
  completed_at   timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists milestones (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid,
  project_id    uuid references projects(id) on delete cascade,
  title         text not null,
  due_date      date,
  completed     boolean default false,
  completed_at  timestamptz,
  created_at    timestamptz default now()
);


-- ---------------------------------------------------------------------------
-- 1. Heal the shape (no-ops on a table this file just created)
-- ---------------------------------------------------------------------------

alter table projects add column if not exists user_id       uuid;
alter table projects add column if not exists month         date;
alter table projects add column if not exists name          text;
alter table projects add column if not exists description   text;
alter table projects add column if not exists type          text;
alter table projects add column if not exists stack         text;
alter table projects add column if not exists done_criteria text;
alter table projects add column if not exists status        text default 'active';
alter table projects add column if not exists outcome_note  text;
alter table projects add column if not exists carried_from  date;
alter table projects add column if not exists completed_at  timestamptz;
alter table projects add column if not exists created_at    timestamptz default now();
alter table projects add column if not exists updated_at    timestamptz not null default now();

alter table milestones add column if not exists user_id      uuid;
alter table milestones add column if not exists project_id   uuid references projects(id) on delete cascade;
alter table milestones add column if not exists title        text;
alter table milestones add column if not exists due_date     date;
alter table milestones add column if not exists completed    boolean default false;
alter table milestones add column if not exists completed_at timestamptz;
alter table milestones add column if not exists created_at   timestamptz default now();

-- The hand-made tables left these nullable; the app never writes a null.
update projects   set status    = 'active' where status is null;
update projects   set created_at = now()   where created_at is null;
update milestones set completed = false    where completed is null;
update milestones set created_at = now()   where created_at is null;
alter table projects   alter column status     set not null;
alter table projects   alter column created_at set not null;
alter table milestones alter column completed  set not null;
alter table milestones alter column created_at set not null;

-- Refuse clearly, as 004 does: a required column this file does not manage
-- would reject every insert the app makes, from inside the verify block,
-- naming a column nobody has heard of.
do $$
declare
  foreign_required text;
begin
  select string_agg(table_name || '.' || column_name, ', ' order by table_name, ordinal_position)
    into foreign_required
    from information_schema.columns
   where table_schema = 'public'
     and table_name in ('projects', 'milestones')
     and is_nullable = 'NO'
     and column_default is null
     and column_name not in ('id', 'user_id', 'month', 'name', 'title', 'status', 'completed',
                             'created_at', 'updated_at');

  if foreign_required is not null then
    raise exception
      'projects/milestones have required column(s) this migration does not manage: %', foreign_required
      using hint = 'Make them nullable or give them defaults, then re-run.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. Claim any existing rows, then require an owner
--
-- 014's rule, restated for two tables: an explicit `set local jare.owner`
-- wins; otherwise the single account in auth.users; anything ambiguous is
-- a refusal, not a guess. The tables were empty on 2026-09-22, so this is
-- expected to claim nothing -- it exists so the NOT NULL below can never
-- fail on a row somebody added by hand in the meantime.
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id   uuid;
  user_count integer;
  unowned    integer;
begin
  select count(*) into unowned
    from (select 1 from projects where user_id is null
          union all select 1 from milestones where user_id is null) u;

  if unowned > 0 then
    begin
      owner_id := nullif(current_setting('jare.owner', true), '')::uuid;
    exception when others then
      raise exception 'jare.owner is set but is not a uuid: %', current_setting('jare.owner', true);
    end;

    if owner_id is null then
      select count(*) into user_count from auth.users;
      if user_count = 0 then
        raise exception 'projects/milestones hold unowned rows and auth.users is empty. Sign in once, then re-run.';
      elsif user_count > 1 then
        raise exception 'projects/milestones hold unowned rows and auth.users holds % accounts. Re-run with: set local jare.owner = ''<uuid>'';', user_count;
      end if;
      select id into owner_id from auth.users;
    end if;

    update projects   set user_id = owner_id where user_id is null;
    update milestones set user_id = owner_id where user_id is null;
    raise notice 'claimed % unowned project/milestone row(s) for %', unowned, owner_id;
  end if;
end
$$;

alter table projects   alter column user_id set not null;
alter table projects   alter column user_id set default auth.uid();
alter table milestones alter column user_id set not null;
alter table milestones alter column user_id set default auth.uid();


-- ---------------------------------------------------------------------------
-- 3. Constraints
--
-- The hand-made checks already spelt these values with hyphens
-- ('hands-on', 'carried-over'); the app adopts that spelling rather than
-- renaming a value nothing has written yet. Dropped and recreated by name
-- so a fresh and a healed database end up with identical definitions.
-- ---------------------------------------------------------------------------

alter table projects drop constraint if exists projects_type_check;
alter table projects add  constraint projects_type_check
  check (type is null or type in ('coding', 'hands-on'));

alter table projects drop constraint if exists projects_status_check;
alter table projects add  constraint projects_status_check
  check (status in ('active', 'complete', 'carried-over'));

alter table projects drop constraint if exists projects_name_not_blank;
alter table projects add  constraint projects_name_not_blank
  check (length(trim(name)) > 0);

-- A project belongs to a month, not a day: the picker sends the 1st.
alter table projects drop constraint if exists projects_month_is_first;
alter table projects add  constraint projects_month_is_first
  check (month = date_trunc('month', month)::date);

alter table milestones drop constraint if exists milestones_title_not_blank;
alter table milestones add  constraint milestones_title_not_blank
  check (length(trim(title)) > 0);

create index if not exists projects_user_month_idx    on projects   (user_id, month desc);
create index if not exists milestones_project_idx     on milestones (project_id);
create index if not exists milestones_user_due_idx    on milestones (user_id, due_date) where completed = false;


-- ---------------------------------------------------------------------------
-- 4. Ownership replaces the lock 015 put on
-- ---------------------------------------------------------------------------

alter table projects   enable row level security;
alter table milestones enable row level security;

drop policy if exists projects_no_access on projects;
drop policy if exists projects_all_authenticated on projects;
create policy projects_all_authenticated on projects
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists milestones_no_access on milestones;
drop policy if exists milestones_all_authenticated on milestones;
create policy milestones_all_authenticated on milestones
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 5. Verify
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col  text;
  policy_count integer;
  test_user    uuid := gen_random_uuid();
  test_project uuid;
  left_behind  integer;
begin
  select string_agg(c, ', ')
    into missing_col
    from unnest(array['user_id','month','name','type','status','carried_from','completed_at','updated_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'projects' and column_name = c
   );
  if missing_col is not null then
    raise exception 'projects is missing column(s): %', missing_col;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name in ('projects', 'milestones')
       and column_name = 'user_id' and is_nullable = 'YES'
  ) then
    raise exception 'user_id must be NOT NULL on projects and milestones';
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('projects', 'milestones') and policyname like '%_no_access') then
    raise exception 'the 015 lock is still on';
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename in ('projects', 'milestones')
     and qual like '%user_id%' and with_check like '%user_id%';
  if policy_count <> 2 then
    raise exception 'expected one owner-scoped policy on each of projects and milestones, found %', policy_count;
  end if;

  -- A milestone follows its project out.
  insert into projects (user_id, month, name, type) values (test_user, date '1990-04-01', '__check__', 'coding')
    returning id into test_project;
  insert into milestones (user_id, project_id, title) values (test_user, test_project, 'first');
  delete from projects where id = test_project;
  select count(*) into left_behind from milestones where project_id = test_project;
  if left_behind <> 0 then
    raise exception 'deleting a project left % milestone(s) behind', left_behind;
  end if;

  begin
    insert into projects (user_id, month, name, status) values (test_user, date '1990-04-01', 'x', 'paused');
    raise exception 'projects_status_check accepted an unknown status';
  exception when check_violation then
    null;
  end;

  begin
    insert into projects (user_id, month, name) values (test_user, date '1990-04-15', 'x');
    raise exception 'projects_month_is_first accepted a mid-month date';
  exception when check_violation then
    null;
  end;

  delete from projects where user_id = test_user;

  raise notice 'projects + milestones verified: owned, checked, cascading, RLS on';
end
$$;
