-- ============================================================================
-- 020_category_rules.sql
--
-- A table-driven, user-editable successor to sit alongside
-- applyCategoryOverrides() (src/lib/sync/categorize.js). That function stays:
-- its three rules (bank-charge narrations, ATM cash, savings/investment
-- inflow-by-wallet-type) are facts about the account, true regardless of what
-- any one person prefers, and nothing a UI should let get edited away by
-- accident. This table is for the different, genuinely personal case --
-- "always file Netflix under Subscriptions" -- that only the user can know,
-- and is checked first, ahead of those structural facts, because it is the
-- more specific signal.
--
-- Idempotent; safe to re-run. RLS enabled with `auth.uid() = user_id` from
-- the first version, same as 018.
-- ============================================================================

create table if not exists category_rules (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  -- What to match against: the transaction's description or its recipient.
  -- A short, closed set rather than free text, so a typo here fails loud at
  -- save time instead of quietly matching nothing forever.
  trigger_field    text not null,
  -- Matched as a case-insensitive substring, not a regex -- the same
  -- "something a person would say" bar the rest of this app's inputs hold to
  -- (see GoalForm's validateGoal), not a pattern language to learn.
  trigger_value    text not null,
  action_category  text not null,
  -- Lower runs first. Ties broken by creation order, which is why the rule
  -- reader sorts by (priority, created_at) rather than priority alone.
  priority         integer not null default 0,
  created_at       timestamptz not null default now()
);

alter table category_rules add column if not exists user_id          uuid not null default auth.uid();
alter table category_rules add column if not exists trigger_field    text;
alter table category_rules add column if not exists trigger_value    text;
alter table category_rules add column if not exists action_category text;
alter table category_rules add column if not exists priority        integer not null default 0;
alter table category_rules add column if not exists created_at      timestamptz not null default now();

alter table category_rules drop constraint if exists category_rules_trigger_field_valid;
alter table category_rules add  constraint category_rules_trigger_field_valid
  check (trigger_field in ('description', 'recipient'));

alter table category_rules drop constraint if exists category_rules_trigger_value_not_blank;
alter table category_rules add  constraint category_rules_trigger_value_not_blank
  check (length(trim(trigger_value)) > 0);

alter table category_rules drop constraint if exists category_rules_action_category_not_blank;
alter table category_rules add  constraint category_rules_action_category_not_blank
  check (length(trim(action_category)) > 0);

create index if not exists category_rules_user_priority_idx
  on category_rules (user_id, priority, created_at);

alter table category_rules enable row level security;

drop policy if exists category_rules_all_authenticated on category_rules;
create policy category_rules_all_authenticated on category_rules
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  missing_col   text;
  policy_count  integer;
begin
  select string_agg(c, ', ')
    into missing_col
    from unnest(array['user_id','trigger_field','trigger_value','action_category','priority','created_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'category_rules' and column_name = c
   );

  if missing_col is not null then
    raise exception 'category_rules is missing column(s): %', missing_col;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'category_rules'
       and column_name = 'user_id' and is_nullable = 'NO'
  ) then
    raise exception 'category_rules.user_id must be NOT NULL';
  end if;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'category_rules'
     and qual like '%user_id%' and with_check like '%user_id%';

  if policy_count <> 1 then
    raise exception 'expected exactly one owner-scoped policy on category_rules, found %', policy_count;
  end if;

  raise notice 'category_rules verified: owned, field-checked, RLS on from the start';
end
$$;
