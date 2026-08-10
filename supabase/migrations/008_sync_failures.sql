-- ============================================================================
-- 008_sync_failures.sql
--
-- Run after 007. Idempotent; safe to re-run.
--
-- A message the sync could not handle is retried on the next run, which is
-- right -- a transient LLM outage and a permanently unreadable email look
-- identical at the moment they fail, and losing a real transaction is worse
-- than re-reading one message.
--
-- Retrying it forever is not right. Two Opay alerts no model could parse held
-- `integrations.last_sync` at 2026-08-05 across every run that followed: each
-- run re-fetched the same window, failed the same two messages, and recomputed
-- the same watermark. Nothing was lost and nothing was duplicated. But the scan
-- window was anchored to a fixed date while the calendar moved on, so the cost
-- of a run grew without bound -- a month later, six runs a day would each
-- re-read a month of email and re-spend the model calls to reach the same
-- conclusion as the run before.
--
-- This table is the memory that makes "give up eventually" possible. A single
-- run cannot answer "has this failed before"; only something persistent can.
-- ============================================================================

create table if not exists sync_failures (
  id              uuid primary key default gen_random_uuid(),

  -- The Gmail message id. Unique because the whole point is counting attempts
  -- per message: without this constraint a run that failed twice would insert
  -- two rows saying "attempt 1" and the count would never climb.
  message_id      text not null,

  attempts        integer not null default 1,

  -- Set once attempts reaches the limit. Stored rather than derived so the
  -- threshold can change in code without rewriting what past runs concluded,
  -- and so this is answerable in SQL without knowing the constant.
  gave_up         boolean not null default false,

  -- Enough context to act on it. Without the date you cannot find the email;
  -- without the error you cannot tell a bank that changed its format from a
  -- provider that was down.
  source          text,
  message_date    timestamptz,
  last_error      text,

  first_failed_at timestamptz not null default now(),
  last_failed_at  timestamptz not null default now()
);

-- Heal a table that predates this file, in the shape of 004: `create table if
-- not exists` skips silently when something by that name is already there, and
-- would then fail on the first statement naming a column it never had --
-- stopping every later migration in the directory with it.
alter table sync_failures add column if not exists message_id      text;
alter table sync_failures add column if not exists attempts        integer not null default 1;
alter table sync_failures add column if not exists gave_up         boolean not null default false;
alter table sync_failures add column if not exists source          text;
alter table sync_failures add column if not exists message_date    timestamptz;
alter table sync_failures add column if not exists last_error      text;
alter table sync_failures add column if not exists first_failed_at timestamptz not null default now();
alter table sync_failures add column if not exists last_failed_at  timestamptz not null default now();

-- Collapse duplicates before the unique index is attempted.
--
-- This is the lesson of 004, which died on exactly this statement shape:
-- `create unique index` against a table already holding duplicate values fails,
-- and because the runner applies this directory in order, that one error blocks
-- every migration after it -- which is how the app ended up querying a column
-- that did not exist.
--
-- Collapsing is safe here in a way it was not for wallets: duplicate rows in a
-- retry counter carry no independent meaning, so the one that has seen the most
-- attempts is kept and the rest are dropped. Nothing a user typed is at risk.
delete from sync_failures a
 using sync_failures b
 where a.message_id is not null
   and a.message_id = b.message_id
   and (a.attempts, a.id) < (b.attempts, b.id);

-- The upsert in the sync targets this constraint by name via onConflict. A
-- plain index would not do: PostgREST needs a unique constraint or index to
-- arbitrate, and without one every upsert fails with 42P10 rather than
-- updating.
create unique index if not exists sync_failures_message_id_uniq
  on sync_failures (message_id);

-- NOT NULL last, and only when the existing rows already satisfy it. A row with
-- no message_id cannot be counted against anything and is ignored by the sync,
-- but silently deleting rows is not this migration's call -- so it says what it
-- found and leaves the column nullable instead of aborting the run.
do $$
begin
  if exists (select 1 from sync_failures where message_id is null) then
    raise warning 'sync_failures has rows with a null message_id, so the column stays nullable. Delete them and re-run this migration.';
  else
    alter table sync_failures alter column message_id set not null;
  end if;
end
$$;

-- "What has the sync given up on" is the question this table exists to answer,
-- and it is asked against a table that should stay small.
create index if not exists sync_failures_gave_up_idx
  on sync_failures (gave_up, message_date desc) where gave_up = true;

alter table sync_failures enable row level security;

-- Matches the policy shape used by every other table in this project today.
-- Tighten alongside the others when multi-tenancy lands.
drop policy if exists sync_failures_all_authenticated on sync_failures;
create policy sync_failures_all_authenticated on sync_failures
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Verify
--
-- The unique constraint is the load-bearing part -- if it is missing the sync
-- still runs, still writes, and still never counts past one, which is the
-- original bug wearing a new table. So it is asserted rather than assumed.
-- ---------------------------------------------------------------------------

do $$
begin
  insert into sync_failures (message_id, attempts, last_error)
  values ('__migration_check_008__', 1, 'check');

  insert into sync_failures (message_id, attempts, last_error)
  values ('__migration_check_008__', 2, 'check')
  on conflict (message_id) do update set attempts = excluded.attempts;

  if (select attempts from sync_failures where message_id = '__migration_check_008__') <> 2 then
    raise exception 'sync_failures upsert did not increment; the unique index is not arbitrating';
  end if;

  delete from sync_failures where message_id = '__migration_check_008__';

  raise notice 'sync_failures verified: upsert on message_id increments attempts';
end
$$;

select 'sync_failures' as table_name, count(*) as rows from sync_failures;
