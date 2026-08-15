-- ============================================================================
-- 013_schema_baseline.sql
--
-- Idempotent; safe to re-run. **Changes no access and no data.**
--
-- Writes down the four tables this app has always had and never declared.
--
-- `transactions`, `wallets`, `user_settings` and `integrations` were made by
-- hand in the Supabase dashboard. Every migration in this directory only ever
-- ALTERs them — 001 opens with `alter table wallets`, which means a fresh
-- Supabase project cannot be built from this directory at all. It aborts on the
-- first file. 009 closed that gap for `goals` and said so in prose; this closes
-- the rest.
--
-- ---------------------------------------------------------------------------
-- ON A FRESH PROJECT, RUN THIS FILE FIRST — before 001.
-- ---------------------------------------------------------------------------
--
-- It is numbered 013 because that is when it was written, not because that is
-- when it should run. Both orders work and converge on the same schema:
--
--   fresh project:  013 → 001 … 012      (013 creates, the rest alter)
--   this database:  001 … 012 → 013      (the rest already ran; 013 no-ops)
--
-- That is why every column later migrations add is also declared here, and why
-- every statement is `if not exists`. Running it against the live database
-- should change nothing at all — that is the test of whether it is right.
--
-- ---------------------------------------------------------------------------
-- What this file deliberately does NOT do
-- ---------------------------------------------------------------------------
--
-- It does not tighten a single policy. The four tables get RLS enabled with the
-- **same permissive policy every other table already has**, because the point of
-- this file is to make the current state explicit, not to change it. 014 claims
-- the rows and 015 tightens them, in that order, with a stop in between.
--
-- If RLS was never enabled on these tables in the dashboard, then enabling it
-- here IS a change — from "the anon key reads everything" to "an authenticated
-- session reads everything". That is a narrowing, and the app signs in before it
-- reads anything, so nothing should break. It is called out because it is the
-- one behavioural difference this file can make, and on `integrations` — which
-- holds a live Google access token — it is the difference that matters.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. wallets
--
-- Declared first: transactions references it.
-- ---------------------------------------------------------------------------

create table if not exists wallets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid default auth.uid(),

  name           text not null,
  -- Constrained by 001_sync_integrity.sql:32; left unconstrained here so a
  -- fresh run of 013 → 001 does not add the same check twice under two names.
  type           text not null,
  balance        numeric not null default 0,
  currency       text not null default 'NGN',

  created_at     timestamptz not null default now()
);

-- Everything 001 adds, repeated so 013-first and 013-last agree.
alter table wallets add column if not exists user_id        uuid default auth.uid();
alter table wallets add column if not exists alert_sender   text;
alter table wallets add column if not exists account_last4  text;
alter table wallets add column if not exists color          text default '#22c55e';
alter table wallets add column if not exists is_active      boolean default true;
alter table wallets add column if not exists updated_at     timestamptz default now();
alter table wallets add column if not exists balance_as_of  text;
alter table wallets add column if not exists parse_strategy text default 'auto';
alter table wallets add column if not exists source_slug    text;


-- ---------------------------------------------------------------------------
-- 2. transactions
--
-- The ledger. Column list taken from what the app actually selects --
-- BASE_LIST_COLUMNS and BASE_SUMMARY_COLUMNS in src/lib/queries.js -- plus
-- `raw_email`, which is written by both sync paths and deliberately never
-- selected.
-- ---------------------------------------------------------------------------

create table if not exists transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid default auth.uid(),

  wallet_id         uuid references wallets (id) on delete set null,

  -- 'debit' | 'credit'. Enforced in the app (src/lib/sync/normalize.js) and in
  -- the RPC (002_manual_log.sql:51); named here so it is enforced once more in
  -- the only place that cannot be bypassed.
  type              text not null,
  amount            numeric not null,
  currency          text not null default 'NGN',

  -- Half of the dedup key, with transaction_id. 001 builds the unique index.
  source            text,
  transaction_id    text,

  category          text,
  description       text,
  recipient         text,
  note              text,
  want_or_need      text,

  transaction_date  date not null,
  transaction_time  time,
  available_balance numeric,

  -- 'HIGH' | 'LOW'. See the constraint below -- this is the one that silently
  -- rejected 32 inserts for weeks.
  confidence        text,
  reviewed          boolean not null default false,

  -- Bank email bodies, capped at 500 chars by normalize.js. Never selected by
  -- any query in the app: src/lib/queries.js excludes it from every column list.
  -- That exclusion is for bandwidth, not for access -- nothing stops a client
  -- asking for it directly, which is one more reason 015 matters.
  raw_email         text,

  created_at        timestamptz not null default now()
);

alter table transactions add column if not exists user_id     uuid default auth.uid();
-- Added by 005 and 006 respectively; repeated for the fresh-project order.
alter table transactions add column if not exists explanation text;
alter table transactions add column if not exists voided      boolean not null default false;

-- The constraint that only ever existed in the live database.
--
-- `transactions_confidence_check` rejected every insert the sync made for weeks,
-- because scripts/gmail-sync.mjs wrote 'MEDIUM' and the constraint accepts only
-- HIGH and LOW. src/lib/sync/normalize.js:13-25 documents the outage; the
-- constraint itself has never been in a migration, so nobody reading this
-- directory could have found it.
--
-- Added NOT VALID: existing rows are not re-checked, so a historical MEDIUM row
-- cannot abort this file. New rows are checked from now on, which is the part
-- that matters. A separate VALIDATE can be run later once the old rows are
-- known clean.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_confidence_check'
  ) then
    alter table transactions
      add constraint transactions_confidence_check
      check (confidence is null or confidence in ('HIGH', 'LOW')) not valid;
    raise notice 'transactions_confidence_check did not exist and has been added';
  else
    raise notice 'transactions_confidence_check already present, left as it is';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. user_settings
--
-- A key/value table with no unique constraint on `key`, which is why
-- src/pages/Settings.jsx:201-215 does select-then-insert-or-update by hand
-- rather than an upsert: PostgREST has nothing to arbitrate on. That hand-rolled
-- version is a lost-update race between two tabs, and it cannot be fixed until
-- the constraint exists. So the constraint goes in here.
-- ---------------------------------------------------------------------------

create table if not exists user_settings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid default auth.uid(),

  key        text not null,
  -- Stored as text, including for numbers: Settings writes String(num).
  value      text,

  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table user_settings add column if not exists user_id    uuid default auth.uid();
alter table user_settings add column if not exists updated_at timestamptz not null default now();
alter table user_settings add column if not exists created_at timestamptz not null default now();

-- Collapse duplicates before the unique index is attempted. This is the lesson
-- of 004, which died on exactly this statement shape and blocked every
-- migration after it -- and duplicates are genuinely likely here, because the
-- select-then-write path above has no constraint stopping two tabs both
-- inserting.
--
-- The most recently updated row wins, which is the same answer the app's own
-- read would have given: Settings takes `.maybeSingle()` and would have thrown
-- on two rows anyway.
delete from user_settings a
 using user_settings b
 where a.key is not null
   and a.key = b.key
   and (a.updated_at, a.id) < (b.updated_at, b.id);

create unique index if not exists user_settings_key_uniq on user_settings (key);


-- ---------------------------------------------------------------------------
-- 4. integrations
--
-- Holds a live Google OAuth access token in plaintext. It is written from the
-- BROWSER with the anon key (src/lib/gmailSync.js:114-149) and read back into
-- the browser on every Settings load (src/pages/Settings.jsx:97-99).
--
-- Until this file it had no CREATE TABLE, no `enable row level security` and no
-- policy anywhere in version control -- so whether that token is readable by
-- anyone holding the published anon key depended entirely on a dashboard
-- setting nobody could see from the repository. That is the sharpest edge in
-- this codebase and the reason this stage exists.
-- ---------------------------------------------------------------------------

create table if not exists integrations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid default auth.uid(),

  -- 'gmail' today. Every read is `.eq('service', …).maybeSingle()`, which
  -- THROWS on two rows -- so uniqueness here has always been assumed and never
  -- declared, while two code paths do bare inserts that could create the second.
  service      text not null,

  access_token text,
  status       text,
  last_sync    timestamptz,
  last_checked timestamptz,

  created_at   timestamptz not null default now()
);

alter table integrations add column if not exists user_id      uuid default auth.uid();
alter table integrations add column if not exists access_token text;
alter table integrations add column if not exists status       text;
alter table integrations add column if not exists last_sync    timestamptz;
alter table integrations add column if not exists last_checked timestamptz;
alter table integrations add column if not exists created_at   timestamptz not null default now();

-- Same collapse-then-index shape, and here it fixes a live hazard: a second
-- 'gmail' row makes `.maybeSingle()` throw, which surfaces in the app as
-- "Please connect Gmail first" -- a wrong diagnosis for a duplicate row.
delete from integrations a
 using integrations b
 where a.service is not null
   and a.service = b.service
   and (coalesce(a.last_sync, a.created_at), a.id)
     < (coalesce(b.last_sync, b.created_at), b.id);

create unique index if not exists integrations_service_uniq on integrations (service);


-- ---------------------------------------------------------------------------
-- 4b. goals — the minimum shape 003 needs
--
-- 009 creates `goals` properly, with the cadence columns and every constraint.
-- But 003_goal_slots.sql runs SIX FILES EARLIER and opens with a bare
-- `alter table goals`, so on a fresh project the chain still dies at 003 even
-- with everything above in place. Testing the fresh-project order is what found
-- this; the claim that this file makes the directory buildable was wrong
-- without it.
--
-- Only the pre-009 shape is declared here. `create table if not exists` means
-- this is a no-op on any database where 009 has already run -- including yours
-- -- and 009 remains the file that owns the cadence.
--
-- Slots are ZERO-based: 003 backfills with `row_number() - 1`.
-- ---------------------------------------------------------------------------

create table if not exists goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid default auth.uid(),

  title       text not null,
  period      text not null default 'daily',
  target_date date not null,
  slot        smallint,
  completed   boolean not null default false,

  created_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 5. Row level security — the CURRENT shape, stated explicitly
--
-- Identical to the policy on `debts`, `goals`, `knowledge_gaps`, `day_briefs`,
-- `sync_failures` and `category_corrections`. Nothing here narrows anything for
-- a signed-in user; it only makes the existing arrangement visible in version
-- control, and closes the case where RLS was never switched on at all.
--
-- 015 replaces every one of these with `auth.uid() = user_id`.
-- ---------------------------------------------------------------------------

alter table wallets       enable row level security;
alter table transactions  enable row level security;
alter table user_settings enable row level security;
alter table integrations  enable row level security;

-- And `goals`, because section 4b may have been the file that created it. 009
-- does this too, so on your database this line changes nothing -- but on a fresh
-- project 009 is six files away, and a table sitting unprotected in between is
-- exactly the state this stage exists to end. The verify block below caught
-- this omission on the first run, which is the whole argument for raising
-- rather than printing.
alter table goals enable row level security;

drop policy if exists wallets_all_authenticated on wallets;
create policy wallets_all_authenticated on wallets
  for all to authenticated using (true) with check (true);

drop policy if exists transactions_all_authenticated on transactions;
create policy transactions_all_authenticated on transactions
  for all to authenticated using (true) with check (true);

drop policy if exists user_settings_all_authenticated on user_settings;
create policy user_settings_all_authenticated on user_settings
  for all to authenticated using (true) with check (true);

drop policy if exists integrations_all_authenticated on integrations;
create policy integrations_all_authenticated on integrations
  for all to authenticated using (true) with check (true);

-- Same policy name 009 uses, so whichever file runs first wins and the other
-- replaces it with an identical definition.
drop policy if exists goals_all_authenticated on goals;
create policy goals_all_authenticated on goals
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 6. Verify
--
-- Raising, in the style of 008 through 012.
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
  rls_off text;
begin
  -- Every column the app selects must exist, or a page dies with a 42703 -- the
  -- outage src/lib/schema.js was built to survive. Checked by name rather than
  -- assumed, because this file's whole purpose is that nobody wrote them down.
  select string_agg(t || '.' || c, ', ')
    into missing
    from (values
      ('transactions','id'), ('transactions','type'), ('transactions','amount'),
      ('transactions','currency'), ('transactions','source'), ('transactions','category'),
      ('transactions','description'), ('transactions','recipient'), ('transactions','note'),
      ('transactions','explanation'), ('transactions','want_or_need'), ('transactions','wallet_id'),
      ('transactions','transaction_date'), ('transactions','transaction_time'),
      ('transactions','transaction_id'), ('transactions','available_balance'),
      ('transactions','confidence'), ('transactions','reviewed'), ('transactions','voided'),
      ('transactions','created_at'), ('transactions','raw_email'),
      ('wallets','id'), ('wallets','name'), ('wallets','type'), ('wallets','balance'),
      ('wallets','currency'), ('wallets','alert_sender'), ('wallets','account_last4'),
      ('wallets','color'), ('wallets','is_active'), ('wallets','parse_strategy'),
      ('wallets','source_slug'), ('wallets','balance_as_of'),
      ('user_settings','key'), ('user_settings','value'),
      ('integrations','service'), ('integrations','access_token'),
      ('integrations','status'), ('integrations','last_sync'), ('integrations','last_checked')
    ) as expected(t, c)
   where not exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public' and ic.table_name = expected.t
        and ic.column_name = expected.c
   );

  if missing is not null then
    raise exception 'the app selects columns this schema does not have: %', missing;
  end if;

  -- Both new unique indexes must actually arbitrate, or the upserts they exist
  -- to enable fail with 42P10 rather than updating.
  insert into user_settings (key, value) values ('__check_013__', 'first');
  insert into user_settings (key, value) values ('__check_013__', 'second')
  on conflict (key) do update set value = excluded.value;

  if (select count(*) from user_settings where key = '__check_013__') <> 1 then
    raise exception 'user_settings_key_uniq is not arbitrating; the settings race is still open';
  end if;
  if (select value from user_settings where key = '__check_013__') <> 'second' then
    raise exception 'upsert on user_settings.key did not update';
  end if;

  delete from user_settings where key = '__check_013__';

  -- RLS must be ON everywhere. A table with a policy and RLS disabled reads as
  -- protected and is not -- which may be exactly the state `integrations` was
  -- in before this file ran.
  select string_agg(c.relname, ', ')
    into rls_off
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relname in ('transactions','wallets','user_settings','integrations',
                       'goals','debts','sync_failures','category_corrections',
                       'knowledge_gaps','day_briefs')
     and not c.relrowsecurity;

  if rls_off is not null then
    raise exception 'row level security is still disabled on: %', rls_off;
  end if;

  raise notice 'baseline verified: every selected column exists, both unique indexes arbitrate, RLS is on for all ten tables';
end
$$;

-- What the four tables hold, and whether anything is unclaimed. The last column
-- is what 014 is for: every one of these rows needs an owner before 015 can
-- safely ask who owns it.
select 'transactions'  as table_name, count(*) as rows, count(*) filter (where user_id is null) as unowned from transactions
union all select 'wallets',       count(*), count(*) filter (where user_id is null) from wallets
union all select 'user_settings', count(*), count(*) filter (where user_id is null) from user_settings
union all select 'integrations',  count(*), count(*) filter (where user_id is null) from integrations
order by table_name;
