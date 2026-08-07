-- ============================================================================
-- 001_sync_integrity.sql
--
-- Run this in the Supabase SQL Editor, in order, top to bottom.
--
-- Steps 1-3 are idempotent and safe to re-run.
-- Step 4 DELETES ROWS. Read the preview in step 4a and understand the count
-- before you run 4b.
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
-- 3. Fix the PiggyVest sender
--
-- PiggyVest mail is relayed via amazonses.com but the searchable sender is
-- contact@piggyvest.com. The seeded alerts@piggyvest.com matches nothing.
-- ---------------------------------------------------------------------------

update wallets
   set alert_sender = 'contact@piggyvest.com'
 where lower(name) like '%piggyvest%'
   and coalesce(alert_sender, '') <> 'contact@piggyvest.com';


-- ---------------------------------------------------------------------------
-- 4. Remove existing duplicates
--
-- The unique index in step 5 cannot be created while duplicates exist. They do:
-- the frontend's dedup ID embedded a timestamp, so the same email was inserted
-- again on every sync.
-- ---------------------------------------------------------------------------

-- 4a. PREVIEW FIRST. Run this on its own and look at the numbers.
--     `copies` is how many rows exist for one real transaction.

select source,
       amount,
       transaction_date,
       left(coalesce(description, ''), 60) as description,
       count(*)                            as copies,
       min(created_at)                     as first_seen,
       max(created_at)                     as last_seen
  from transactions
 group by 1, 2, 3, 4
having count(*) > 1
 order by copies desc, last_seen desc;


-- 4b. DELETES ROWS. Keeps the earliest row of each group -- the original
--     insert, with any manual category edits made before the copies appeared.
--     Comment out the `where false` line to arm it.

with ranked as (
  select id,
         row_number() over (
           partition by source, amount, transaction_date, left(coalesce(description, ''), 60)
           order by created_at asc, id asc
         ) as copy_number
    from transactions
)
delete from transactions
 where false  -- <<< DELETE THIS LINE TO ARM THE STATEMENT
   and id in (select id from ranked where copy_number > 1);


-- ---------------------------------------------------------------------------
-- 5. Make duplicates impossible rather than merely unlikely
--
-- Dedup was a SELECT followed by an INSERT with nothing between them, so a
-- cron run overlapping a manual sync inserted the same transaction twice. With
-- this index the database refuses, and the sync switches to an idempotent
-- upsert.
--
-- If this errors with "could not create unique index", step 4b did not run or
-- did not catch everything. Re-run 4a.
-- ---------------------------------------------------------------------------

create unique index if not exists transactions_source_txnid_uniq
    on transactions (source, transaction_id)
 where transaction_id is not null;


-- ---------------------------------------------------------------------------
-- 6. Index the columns the natural-key dedup guard looks up
-- ---------------------------------------------------------------------------

create index if not exists transactions_natural_key_idx
    on transactions (source, transaction_date, amount);


-- ---------------------------------------------------------------------------
-- 7. Verify
-- ---------------------------------------------------------------------------

select name, type, alert_sender, parse_strategy, is_active
  from wallets
 order by created_at;

select count(*) as total_transactions,
       count(distinct (source, transaction_id)) as distinct_keys
  from transactions;
