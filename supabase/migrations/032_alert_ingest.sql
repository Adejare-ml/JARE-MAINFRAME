-- ============================================================================
-- 032_alert_ingest.sql
--
-- Run after 031. Idempotent; safe to re-run.
--
-- The Gmail sync in GitHub Actions depended on a Google refresh token that
-- expires every seven days while the OAuth app sits in "Testing" status,
-- and it has been dead since mid-August. The owner's Claude scheduled task
-- ("Daily spending audit") already reads the same bank alerts through
-- Claude's own Gmail connection, with no token to keep alive, and can run
-- SQL on this project. So the mailbox reading moves there, and this file
-- gives that task a narrow, safe contract: two functions, and nothing else
-- to get right.
--
--   ingest_alert_transaction(...)  one alert in, one row out (or a no-op
--                                  when it is already there), with the
--                                  wallet balance moved forward the same
--                                  way scripts/gmail-sync.mjs did it.
--   record_sync_run(...)           the note Settings -> System reads.
--
-- Every rule the sync enforced lives in here now, in the one place a
-- prompt cannot skip: the owner is resolved (014's rule), the wallet must
-- exist by slug, the direction and amount are checked, the id is unique
-- per (source, transaction_id) so a re-run is a no-op, an alert already
-- imported by the old sync under another id is refused by its natural
-- key, and a balance never walks backwards.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- A constraint nobody declared
--
-- The live database carries `transactions_source_check`, allowing only
-- 'gtbank', 'opay' and 'manual'. It is in no migration -- made by hand in
-- the dashboard, like the confidence check 013 had to declare -- and it
-- rejects every row for any other wallet: the Stanbic alerts the sync
-- parsed, and any slug added in Settings since. The slug space is the
-- owner's data (wallets.source_slug), not a fixed list, so the check
-- becomes "not blank" and the wallet lookup in ingest_alert_transaction
-- is what decides whether a source is real.
-- ---------------------------------------------------------------------------

alter table transactions drop constraint if exists transactions_source_check;

alter table transactions drop constraint if exists transactions_source_not_blank;
alter table transactions add  constraint transactions_source_not_blank
  check (source is null or length(trim(source)) > 0);


-- ---------------------------------------------------------------------------
-- Whose rows. 014's rule, as a function: exactly one account, or refuse.
-- ---------------------------------------------------------------------------

create or replace function jare_sole_owner() returns uuid
language plpgsql
stable
as $$
declare
  owner_id   uuid;
  user_count integer;
begin
  select count(*) into user_count from auth.users;
  if user_count = 0 then
    raise exception 'auth.users is empty; sign in to the app once first';
  elsif user_count > 1 then
    raise exception 'auth.users holds % accounts, so the owner is ambiguous', user_count;
  end if;
  select id into owner_id from auth.users;
  return owner_id;
end
$$;

revoke execute on function jare_sole_owner() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- One alert -> one row
-- ---------------------------------------------------------------------------

create or replace function ingest_alert_transaction(
  p_source            text,                       -- wallet slug: gtbank | opay | stanbic | ...
  p_transaction_id    text,                       -- the Gmail message id (stable, unique)
  p_type              text,                       -- debit | credit
  p_amount            numeric,
  p_date              date,
  p_time              time    default null,
  p_description       text    default null,
  p_recipient         text    default null,
  p_category          text    default 'Uncategorized',
  p_available_balance numeric default null,       -- the balance the alert states, if any
  p_raw_excerpt       text    default null,       -- <= 500 chars of the alert, for review
  p_confidence        text    default 'LOW'       -- HIGH | LOW; LOW lands in the review queue
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_owner    uuid := jare_sole_owner();
  v_source   text := lower(trim(coalesce(p_source, '')));
  v_txid     text := 'CLA-' || trim(coalesce(p_transaction_id, ''));
  v_type     text := lower(trim(coalesce(p_type, '')));
  v_category text := coalesce(nullif(trim(p_category), ''), 'Uncategorized');
  v_conf     text := upper(trim(coalesce(p_confidence, 'LOW')));
  v_wallet   wallets%rowtype;
  v_id       uuid;
  v_at       text;
  v_natural  uuid;
begin
  if v_source = '' then
    raise exception 'p_source (the wallet slug) is required';
  end if;
  if trim(coalesce(p_transaction_id, '')) = '' then
    raise exception 'p_transaction_id (the Gmail message id) is required for idempotency';
  end if;
  if v_type not in ('debit', 'credit') then
    raise exception 'p_type must be debit or credit, got %', p_type;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'p_amount must be positive, got %', p_amount;
  end if;
  if p_date is null then
    raise exception 'p_date is required';
  end if;
  if v_conf not in ('HIGH', 'LOW') then
    raise exception 'p_confidence must be HIGH or LOW, got %', p_confidence;
  end if;

  select * into v_wallet
    from wallets
   where user_id = v_owner and source_slug = v_source;
  if not found then
    raise exception 'no wallet has source_slug %; known: %', v_source,
      (select string_agg(source_slug, ', ' order by source_slug) from wallets where user_id = v_owner);
  end if;

  -- The old sync may have imported this same alert under the bank's own
  -- reference or a SYN- hash. Same wallet, day, direction, amount and payee
  -- from a non-CLA id is that alert, not a new one.
  select id into v_natural
    from transactions
   where user_id = v_owner
     and wallet_id = v_wallet.id
     and transaction_date = p_date
     and type = v_type
     and amount = round(p_amount, 2)
     and coalesce(lower(trim(recipient)), '') = coalesce(lower(trim(p_recipient)), '')
     and transaction_id not like 'CLA-%'
   limit 1;
  if v_natural is not null then
    return jsonb_build_object('inserted', false, 'reason', 'already imported by the old sync',
                              'existing_id', v_natural, 'wallet', v_wallet.name);
  end if;

  insert into transactions
    (user_id, wallet_id, type, amount, currency, source, transaction_id,
     category, description, recipient, transaction_date, transaction_time,
     available_balance, confidence, reviewed, raw_email)
  values
    (v_owner, v_wallet.id, v_type, round(p_amount, 2), 'NGN', v_source, v_txid,
     v_category,
     coalesce(nullif(trim(p_description), ''), nullif(trim(p_recipient), ''), v_category),
     nullif(trim(p_recipient), ''),
     p_date, p_time,
     case when p_available_balance is not null and p_available_balance >= 0 then p_available_balance end,
     v_conf, v_conf = 'HIGH',
     left(p_raw_excerpt, 500))
  on conflict (source, transaction_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('inserted', false, 'reason', 'duplicate', 'wallet', v_wallet.name);
  end if;

  -- Balance from the alert, never backwards: balance_as_of holds the stamp
  -- of the alert the stored balance came from (001), and a delayed older
  -- alert must not overwrite a newer one.
  if p_available_balance is not null and p_available_balance >= 0 then
    v_at := p_date::text || 'T' || coalesce(p_time::text, '00:00:00');
    update wallets
       set balance = p_available_balance, balance_as_of = v_at, updated_at = now()
     where id = v_wallet.id
       and (balance_as_of is null or balance_as_of < v_at);
  end if;

  return jsonb_build_object('inserted', true, 'id', v_id, 'wallet', v_wallet.name,
                            'reviewed', v_conf = 'HIGH');
end
$$;

revoke execute on function ingest_alert_transaction(text, text, text, numeric, date, time, text, text, text, numeric, text, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- The note Settings -> System reads (025), from outside the scripts
-- ---------------------------------------------------------------------------

create or replace function record_sync_run(
  p_job        text,
  p_ok         boolean,
  p_summary    text        default null,
  p_started_at timestamptz default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_owner uuid := jare_sole_owner();
  v_id    uuid;
begin
  if trim(coalesce(p_job, '')) = '' then
    raise exception 'p_job is required';
  end if;

  insert into sync_runs (user_id, job, started_at, finished_at, ok, summary)
  values (v_owner, trim(p_job), coalesce(p_started_at, now()), now(), coalesce(p_ok, false), left(p_summary, 500))
  returning id into v_id;

  -- Same retention as scripts/lib/recordRun.mjs.
  delete from sync_runs
   where user_id = v_owner and job = trim(p_job) and finished_at < now() - interval '90 days';

  -- The audit reads the mailbox, so a good run is a mailbox check: keep the
  -- Settings "Checked ... ago" honest without pretending a token was used.
  if trim(p_job) = 'claude-audit' and p_ok then
    update integrations set last_checked = now() where user_id = v_owner and service = 'gmail';
  end if;

  return v_id;
end
$$;

revoke execute on function record_sync_run(text, boolean, text, timestamptz) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  test_user uuid;
  w         uuid;
  r1        jsonb;
  r2        jsonb;
  r3        jsonb;
  bal       numeric;
  as_of     text;
  refused   boolean := false;
  run_id    uuid;
begin
  if exists (select 1 from pg_constraint where conname = 'transactions_source_check') then
    raise exception 'transactions_source_check is still there; it rejects every wallet but gtbank and opay';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_source_not_blank') then
    raise exception 'transactions_source_not_blank was not created';
  end if;

  select id into test_user from auth.users order by created_at limit 1;
  if test_user is null then
    raise notice 'alert ingest: no account yet, verify skipped';
    return;
  end if;
  if (select count(*) from auth.users) > 1 then
    raise notice 'alert ingest: more than one account, verify skipped';
    return;
  end if;

  insert into wallets (user_id, name, type, balance, source_slug)
  values (test_user, '__ingest_check__', 'bank', 1000, 'ingest_check')
  returning id into w;

  r1 := ingest_alert_transaction('ingest_check', 'msg-032-a', 'debit', 250, '2026-09-22', '09:15:00',
                                 'POS purchase', 'SHOPRITE', 'Feeding / Groceries', 750, 'excerpt', 'HIGH');
  r2 := ingest_alert_transaction('ingest_check', 'msg-032-a', 'debit', 250, '2026-09-22', '09:15:00',
                                 'POS purchase', 'SHOPRITE', 'Feeding / Groceries', 750, 'excerpt', 'HIGH');
  if not (r1->>'inserted')::boolean then raise exception 'first ingest did not insert: %', r1; end if;
  if (r2->>'inserted')::boolean then raise exception 'retry inserted a second row: %', r2; end if;

  select balance, balance_as_of into bal, as_of from wallets where id = w;
  if bal <> 750 or as_of <> '2026-09-22T09:15:00' then
    raise exception 'balance did not follow the alert: % as of %', bal, as_of;
  end if;

  -- An older alert arriving later must not move the balance backwards.
  r3 := ingest_alert_transaction('ingest_check', 'msg-032-b', 'credit', 100, '2026-09-21', '18:00:00',
                                 'Transfer in', 'ADE', 'Uncategorized', 1100, null, 'LOW');
  select balance into bal from wallets where id = w;
  if bal <> 750 then raise exception 'an older alert moved the balance backwards to %', bal; end if;
  if (select reviewed from transactions where transaction_id = 'CLA-msg-032-b') then
    raise exception 'a LOW-confidence row was marked reviewed';
  end if;

  begin
    perform ingest_alert_transaction('no_such_wallet', 'msg-032-c', 'debit', 1, '2026-09-22');
  exception when others then
    refused := true;
  end;
  if not refused then raise exception 'an unknown wallet slug was accepted'; end if;

  run_id := record_sync_run('claude-audit', true, 'verify', now() - interval '1 minute');
  if run_id is null then raise exception 'record_sync_run wrote nothing'; end if;

  delete from sync_runs where id = run_id;
  delete from transactions where wallet_id = w;
  delete from wallets where id = w;

  raise notice 'alert ingest verified: idempotent, balance forward-only, unknown wallet refused, run recorded';
end
$$;
