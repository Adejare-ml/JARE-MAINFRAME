-- ============================================================================
-- 001_sync_integrity.sql
--
-- Run this in the Supabase SQL Editor, top to bottom.
--
-- Steps 1-4 are idempotent and safe to re-run.
-- Step 5 DELETES ROWS and ships disarmed. Read step 5a, then uncomment 5b.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Wallet columns the app already reads
--
-- src/pages/Settings.jsx reads alert_sender, account_last4, color and
-- is_active. If this ALTER was never run, the Banks & Wallets screen is broken.
-- Harmless if it did run.
-- ---------------------------------------------------------------------------

alter table wallets add column if not exists alert_sender   text;
alter table wallets add column if not exists account_last4  text;
alter table wallets add column if not exists color          text default '#22c55e';
alter table wallets add column if not exists is_active      boolean default true;
alter table wallets add column if not exists updated_at     timestamptz default now();

-- Which alert the stored balance came from, as 'YYYY-MM-DDTHH:MM:SS'. Without
-- it a delayed older alert arriving in a later run overwrites a newer balance,
-- walking the wallet backwards in time.
alter table wallets add column if not exists balance_as_of  text;

-- Allow savings and investment wallets, for the layered net worth view.
alter table wallets drop constraint if exists wallets_type_check;
alter table wallets add  constraint wallets_type_check
  check (type in ('bank', 'mobile', 'cash', 'savings', 'investment'));


-- ---------------------------------------------------------------------------
-- 2. Per-wallet parse strategy
--
-- 'rules' -- direction is reliably stated in the alert, never call the LLM
-- 'llm'   -- direction is not recoverable by rules, always call the LLM
-- 'auto'  -- try rules, fall back to the LLM
--
-- Opay and PiggyVest describe money in and money out with the same word
-- ("transfer"), so no keyword rule can tell them apart.
-- ---------------------------------------------------------------------------

alter table wallets add column if not exists parse_strategy text default 'auto';

alter table wallets drop constraint if exists wallets_parse_strategy_check;
alter table wallets add  constraint wallets_parse_strategy_check
  check (parse_strategy in ('rules', 'llm', 'auto'));

update wallets
   set parse_strategy = 'llm'
 where parse_strategy is distinct from 'llm'
   and (lower(name) like '%opay%' or lower(name) like '%piggyvest%');


-- ---------------------------------------------------------------------------
-- 3. An immutable dedup key per wallet
--
-- `transactions.source` is half of the dedup key. Deriving it from the wallet's
-- display name means renaming "GTBank" to "GT Bank" in Settings re-keys every
-- historical alert and the next sync re-inserts the whole window.
--
-- source_slug is written once here and then never rewritten. It is seeded from
-- the source value already dominant in that wallet's existing transactions, so
-- rows already in the table keep their key; only a wallet with no history at
-- all falls back to a slug of its current name.
--
-- Restricted to [a-z0-9_] because the value is interpolated into a PostgREST
-- .or() filter, where a comma or a dot would break or silently widen the query.
-- ---------------------------------------------------------------------------

alter table wallets add column if not exists source_slug text;

update wallets w
   set source_slug = coalesce(
         (select t.source
            from transactions t
           where t.wallet_id = w.id
             and t.source is not null
             and t.source <> ''
             -- 'manual' is how a row was entered, not which wallet it belongs
             -- to, and every wallet's hand-logged rows carry it. Seeding from
             -- it would give a cash wallet the slug 'manual' and collide the
             -- moment a second wallet had hand-logged rows too.
             and t.source <> 'manual'
           group by t.source
           order by count(*) desc, t.source asc
           limit 1),
         nullif(regexp_replace(lower(regexp_replace(trim(w.name), '\s+', '_', 'g')),
                               '[^a-z0-9_]', '', 'g'), '')
       )
 where source_slug is null;

-- A wallet whose name is entirely punctuation would slug to empty; fall back to
-- its UUID so the key is never blank.
update wallets set source_slug = 'wallet_' || replace(id::text, '-', '')
 where source_slug is null or source_slug = '';

-- Two wallets sharing a slug would share a dedup key, so one bank's alerts
-- would silently suppress the other's as duplicates. The index below prevents
-- that, but it fails to create if the seeding above already produced a
-- collision -- most likely with two accounts at the same bank.
--
-- PREVIEW. Expect zero rows. Anything here must be given a distinct slug by
-- hand before the index will build, e.g.
--   update wallets set source_slug = 'gtbank_savings' where id = '...';
-- Choose carefully: this value is half the dedup key, and changing it later
-- re-keys that wallet's whole history.

select source_slug, count(*) as wallets, array_agg(name) as names
  from wallets
 group by source_slug
having count(*) > 1;

create unique index if not exists wallets_source_slug_uniq on wallets (source_slug);


-- ---------------------------------------------------------------------------
-- 4. Fix the PiggyVest sender
--
-- PiggyVest mail is relayed via amazonses.com but the searchable sender is
-- contact@piggyvest.com. The seeded alerts@piggyvest.com matches nothing.
-- ---------------------------------------------------------------------------

update wallets
   set alert_sender = 'contact@piggyvest.com'
 where lower(name) like '%piggyvest%'
   and coalesce(alert_sender, '') <> 'contact@piggyvest.com';


-- ---------------------------------------------------------------------------
-- 5. Remove rows that would violate the unique index in step 6
--
-- These exist because the frontend's old dedup ID embedded a timestamp, so the
-- same email was inserted again on every sync.
--
-- This groups ONLY on (source, transaction_id) -- exactly what the index
-- enforces. Grouping on amount and date as well would merge genuinely distinct
-- transactions: two NGN 50 stamp-duty charges on the same day are two real
-- charges carrying two real bank references, and deleting one is data loss.
-- ---------------------------------------------------------------------------

-- 5a. PREVIEW. Run this alone first. Every row here is a true duplicate: same
--     bank reference, same wallet, recorded more than once.

select source,
       transaction_id,
       count(*)        as copies,
       min(created_at) as first_seen,
       max(created_at) as last_seen
  from transactions
 where transaction_id is not null
 group by source, transaction_id
having count(*) > 1
 order by copies desc, last_seen desc;


-- 5b. DELETES ROWS. Uncomment the whole statement to arm it. It keeps the
--     earliest row of each group -- the original insert, carrying any manual
--     category edits made before the copies appeared.
--
-- with ranked as (
--   select id,
--          row_number() over (
--            partition by source, transaction_id
--            order by created_at asc, id asc
--          ) as copy_number
--     from transactions
--    where transaction_id is not null
-- )
-- delete from transactions
--  where id in (select id from ranked where copy_number > 1);


-- 5c. Rows whose transaction_id was generated by the OLD non-deterministic
--     algorithm cannot be matched this way -- every copy got a different ID, so
--     step 5b does not see them. Preview them here.
--
--     JUDGEMENT CALL: unlike 5a these are not certainly duplicates. Two
--     identical-looking charges on one day may be two real charges. Read the
--     rows before deciding, and prefer leaving them: the new dedup is
--     idempotent, so leftovers stop growing even if you keep them.

select source,
       amount,
       transaction_date,
       left(coalesce(description, ''), 60) as description,
       count(*)                            as copies,
       array_agg(transaction_id)           as ids
  from transactions
 where transaction_id like 'SYN-%'
 group by 1, 2, 3, 4
having count(*) > 1
 order by copies desc;


-- ---------------------------------------------------------------------------
-- 6. Make duplicates impossible rather than merely unlikely
--
-- Dedup was a SELECT followed by an INSERT with nothing between them, so a cron
-- run overlapping a manual sync inserted the same transaction twice. With this
-- index the database refuses, and the sync uses an idempotent upsert.
--
-- The index is deliberately TOTAL, not partial. PostgREST renders
-- .upsert({onConflict:'source,transaction_id'}) as ON CONFLICT (source,
-- transaction_id) with no WHERE clause, and Postgres will not infer a PARTIAL
-- unique index as an arbiter unless the statement repeats its predicate. A
-- partial index here makes every insert fail with 42P10.
--
-- Rows with a null transaction_id are unaffected: Postgres treats NULLs as
-- distinct in a unique index, so any number of them coexist. The sync always
-- fills in a synthetic ID before inserting, so it never writes one.
--
-- If this errors with "could not create unique index", step 5b has not been run.
-- Re-run 5a.
-- ---------------------------------------------------------------------------

drop index if exists transactions_source_txnid_uniq;

create unique index if not exists transactions_source_txnid_uniq
    on transactions (source, transaction_id);


-- ---------------------------------------------------------------------------
-- 7. Index the columns the natural-key dedup guard looks up
-- ---------------------------------------------------------------------------

create index if not exists transactions_natural_key_idx
    on transactions (source, transaction_date, amount);


-- ---------------------------------------------------------------------------
-- 8. Verify
-- ---------------------------------------------------------------------------

select name, type, source_slug, alert_sender, parse_strategy, is_active
  from wallets
 order by created_at;

-- Expect zero rows. Anything here would have blocked the index in step 6.
select source, transaction_id, count(*)
  from transactions
 where transaction_id is not null
 group by source, transaction_id
having count(*) > 1;
