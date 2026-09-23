-- ============================================================================
-- 030_categories.sql
--
-- Run after 029. Idempotent; safe to re-run, including against a
-- `categories` table that already exists in another shape.
--
-- The category list has been a fixed constant since day one
-- (src/lib/constants.js). `transactions.category` is plain text with no
-- check constraint (013), so a custom name has always been *storable* --
-- there was just no way to make one up and have the pickers offer it. This
-- table is one row per custom name, owner-scoped, merged into the built-in
-- list by src/lib/categories.js.
--
-- Deliberately narrow. Deleting a row does not rewrite transactions that
-- carry the name (they keep it; the ledger is a record, not a view of this
-- table), and nothing here reaches the email sync's model prompt, which
-- stays on the built-in list so it never invents a name.
-- ============================================================================

create table if not exists categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  name       text not null,
  -- Which heading the picker shows it under. Defaults to its own section;
  -- a built-in heading's name files it there instead.
  section    text not null default 'Custom',
  icon       text,
  created_at timestamptz not null default now()
);

-- Heal an older shape before constraining it (004's rule).
alter table categories add column if not exists user_id    uuid not null default auth.uid();
alter table categories add column if not exists name       text;
alter table categories add column if not exists section    text not null default 'Custom';
alter table categories add column if not exists icon       text;
alter table categories add column if not exists created_at timestamptz not null default now();

do $$
begin
  if exists (select 1 from categories where name is null) then
    raise warning 'categories has rows with a null name, so the column stays nullable. Fill them in and re-run this migration.';
  else
    alter table categories alter column name set not null;
  end if;
end
$$;

alter table categories drop constraint if exists categories_name_not_blank;
alter table categories add  constraint categories_name_not_blank
  check (length(trim(name)) > 0);

-- Matches NAME_MAX in src/lib/categories.js: a category is a label on a
-- chip, not a sentence.
alter table categories drop constraint if exists categories_name_length;
alter table categories add  constraint categories_name_length
  check (length(name) <= 40);

alter table categories drop constraint if exists categories_section_not_blank;
alter table categories add  constraint categories_section_not_blank
  check (length(trim(section)) > 0);

-- Dedupe before the unique index: "Pets" and "pets " are one category, and
-- the oldest row wins so an id already referenced anywhere stays valid.
delete from categories newer
 using categories older
 where newer.user_id = older.user_id
   and lower(trim(newer.name)) = lower(trim(older.name))
   and (older.created_at < newer.created_at
        or (older.created_at = newer.created_at and older.id < newer.id));

create unique index if not exists categories_user_name_idx
  on categories (user_id, lower(trim(name)));

alter table categories enable row level security;

drop policy if exists categories_all_authenticated on categories;
create policy categories_all_authenticated on categories
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col  text;
  policy_count integer;
  test_user    uuid;
  dup_refused  boolean := false;
begin
  select string_agg(c, ', ')
    into missing_col
    from unnest(array['user_id','name','section','icon','created_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'categories' and column_name = c
   );
  if missing_col is not null then
    raise exception 'categories is missing column(s): %', missing_col;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'categories'
       and column_name = 'user_id' and is_nullable = 'NO'
  ) then
    raise exception 'categories.user_id must be NOT NULL';
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'categories'
     and qual like '%user_id%' and with_check like '%user_id%';
  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on categories, found %', policy_count;
  end if;

  if not exists (select 1 from pg_indexes where indexname = 'categories_user_name_idx') then
    raise exception 'categories_user_name_idx was not created';
  end if;

  -- Round trip: the index must treat case and padding as the same name.
  select id into test_user from auth.users order by created_at limit 1;
  if test_user is null then
    raise notice 'categories: no account yet, dedupe check skipped';
    return;
  end if;

  insert into categories (user_id, name, icon) values (test_user, '__Check Category__', '🏷️');
  begin
    insert into categories (user_id, name) values (test_user, '  __check category__ ');
  exception when unique_violation then
    dup_refused := true;
  end;
  delete from categories where user_id = test_user and lower(trim(name)) = '__check category__';

  if not dup_refused then
    raise exception 'categories accepted the same name twice with different case';
  end if;

  raise notice 'categories verified: owned, not blank, one per name per user';
end
$$;
