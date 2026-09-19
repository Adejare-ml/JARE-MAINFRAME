-- ============================================================================
-- 024_category_budgets.sql
--
-- Per-category monthly targets, sitting alongside the one overall monthly
-- budget target that already lives in user_settings ('monthly_budget_target').
-- That key stays -- this is a finer-grained, optional addition, not a
-- replacement: a category with no row here simply has no target, and
-- Budget.jsx's overall figure is unaffected either way.
--
-- Same shape as 020_category_rules.sql, the closest existing precedent: a
-- small, user-owned table with no reason for anyone else to read or write a
-- row that is not theirs. RLS enabled with `auth.uid() = user_id` from the
-- first version.
--
-- Idempotent; safe to re-run.
-- ============================================================================

create table if not exists category_budgets (
  id             uuid primary key default gen_random_uuid(),
  -- The default belongs here, not only on the healing ALTER below: on a
  -- genuinely fresh install this CREATE runs and the ALTER's `add column if
  -- not exists` is then a no-op (the column already exists), so a default
  -- stated only there would never take effect for a first-ever run.
  user_id        uuid not null default auth.uid(),
  -- Not constrained to ALL_CATEGORIES here -- that list lives in
  -- src/lib/constants.js and changes without a migration; a database-level
  -- enum would need one every time it did. A blank category is still
  -- refused below, the same bar category_rules.action_category holds to.
  category       text not null,
  target_amount  numeric not null,
  created_at     timestamptz not null default now()
);

alter table category_budgets add column if not exists user_id        uuid not null default auth.uid();
alter table category_budgets add column if not exists category       text;
alter table category_budgets add column if not exists target_amount  numeric;
alter table category_budgets add column if not exists created_at     timestamptz not null default now();

alter table category_budgets drop constraint if exists category_budgets_category_not_blank;
alter table category_budgets add  constraint category_budgets_category_not_blank
  check (length(trim(category)) > 0);

alter table category_budgets drop constraint if exists category_budgets_target_non_negative;
alter table category_budgets add  constraint category_budgets_target_non_negative
  check (target_amount >= 0);

-- Collapse duplicates before the unique index is attempted -- the lesson of
-- 004, which died on exactly this statement shape and blocked every
-- migration after it. One target per user per category: the most recently
-- created row for a (user_id, category) pair is the one that survives.
delete from category_budgets a
 using category_budgets b
 where a.user_id = b.user_id
   and a.category = b.category
   and (a.created_at, a.id) < (b.created_at, b.id);

-- Targeted by name via onConflict: 'user_id,category' in the app's upsert. A
-- plain index would not do -- PostgREST needs a unique constraint or index to
-- arbitrate, and without one every upsert fails with 42P10 rather than
-- replacing the existing target.
create unique index if not exists category_budgets_user_category_uniq
  on category_budgets (user_id, category);

alter table category_budgets enable row level security;

drop policy if exists category_budgets_all_authenticated on category_budgets;
create policy category_budgets_all_authenticated on category_budgets
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Verify
--
-- Raising, in the style of 020 through 023.
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col    text;
  policy_count   integer;
  test_user      uuid := gen_random_uuid();
  stored_count   integer;
  stored_target  numeric;
begin
  select string_agg(c, ', ')
    into missing_col
    from unnest(array['user_id','category','target_amount','created_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'category_budgets' and column_name = c
   );

  if missing_col is not null then
    raise exception 'category_budgets is missing column(s): %', missing_col;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'category_budgets'
       and column_name = 'user_id' and is_nullable = 'NO'
  ) then
    raise exception 'category_budgets.user_id must be NOT NULL';
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'category_budgets'
     and qual like '%user_id%' and with_check like '%user_id%';

  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on category_budgets, found %', policy_count;
  end if;

  -- The upsert this table exists for must REPLACE a user's target for a
  -- category, not accumulate a second row beside it.
  insert into category_budgets (user_id, category, target_amount)
  values (test_user, 'Transport', 5000);

  insert into category_budgets (user_id, category, target_amount)
  values (test_user, 'Transport', 8000)
  on conflict (user_id, category) do update
    set target_amount = excluded.target_amount;

  select count(*), max(target_amount) into stored_count, stored_target
    from category_budgets where user_id = test_user and category = 'Transport';

  if stored_count <> 1 then
    raise exception 'category_budgets upsert made % rows for one (user, category); the unique index is not arbitrating', stored_count;
  end if;
  if stored_target <> 8000 then
    raise exception 'category_budgets upsert did not replace the existing target';
  end if;

  begin
    insert into category_budgets (user_id, category, target_amount) values (test_user, '   ', 1000);
    raise exception 'category_budgets_category_not_blank accepted a blank category';
  exception when check_violation then
    null;
  end;

  begin
    insert into category_budgets (user_id, category, target_amount) values (test_user, 'Rent', -1);
    raise exception 'category_budgets_target_non_negative accepted a negative target';
  exception when check_violation then
    null;
  end;

  delete from category_budgets where user_id = test_user;

  raise notice 'category_budgets verified: owned, field-checked, one target per category, RLS on from the start';
end
$$;
