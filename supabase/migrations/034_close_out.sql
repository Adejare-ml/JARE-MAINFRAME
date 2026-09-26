-- ============================================================================
-- 034_close_out.sql
--
-- Run after 033. Idempotent; safe to re-run.
--
-- The close-out pass before the app runs unattended. Three audits read the
-- repository and the live database on 26 Sep 2026; this file is the part of
-- their findings that lives in SQL.
--
--   1. week_recaps was the one table still open to any signed-in account
--      (023 copied the pre-015 policy shape). Sign-ups are on by default in
--      Supabase Auth, so a stranger holding the app's public key could read
--      and edit the owner's recaps. Owner-scoped now, like every other table.
--   2. jare_sole_owner() refused to guess between two accounts and had no
--      way to be told. It now honours a pinned owner in the jare.owner
--      setting. (Supabase refuses to store that setting on the database or
--      the role, so 035 moves the pin into a one-row table; the setting
--      remains for a one-off `set local`.)
--   3. ingest_alert_transaction gets back the guards the token sync had
--      (src/lib/sync/normalize.js, categorize.js) and a few it never needed:
--        - free text is whitespace-normalised and capped (recipient 200,
--          description 500, excerpt 500);
--        - a category that is neither built in nor one of the owner's own
--          becomes Uncategorized at LOW confidence, so it reaches review;
--        - the owner's category_rules are applied, in priority order;
--        - an amount above the review ceiling is LOW, never auto-reviewed;
--        - a date more than a day ahead is LOW and never moves a balance:
--          balance_as_of is forward-only, so one future-dated alert used to
--          freeze a wallet for good;
--        - the "already imported by the old sync" guard ignores voided rows
--          and app-logged MAN- rows, and still moves the balance forward;
--        - bad input (unknown wallet, bad direction, non-positive amount,
--          missing id or date) comes back as {"inserted": false, "reason":
--          "refused", ...} instead of raising, so one odd alert cannot roll
--          back a whole batch.
--   4. record_sync_run's ledger cleanup matches only the exact
--      claude_audit_YYYYMMDD names the fallback path would create.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. week_recaps belongs to its owner
-- ---------------------------------------------------------------------------

alter table week_recaps enable row level security;

-- Rows the cron wrote carry user_id already; heal any older one while the
-- owner is still unambiguous.
update week_recaps set user_id = (select id from auth.users)
 where user_id is null and (select count(*) from auth.users) = 1;

drop policy if exists week_recaps_all_authenticated on week_recaps;
drop policy if exists week_recaps_owner on week_recaps;
create policy week_recaps_owner on week_recaps
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 2. Whose rows: a pinned owner first, then 014's single-account rule
-- ---------------------------------------------------------------------------

create or replace function jare_sole_owner() returns uuid
language plpgsql
stable
as $$
declare
  pinned_text text := nullif(current_setting('jare.owner', true), '');
  pinned      uuid;
  owner_id    uuid;
  user_count  integer;
begin
  if pinned_text is not null then
    begin
      pinned := pinned_text::uuid;
    exception when others then
      raise exception 'jare.owner is set but is not a uuid: %', pinned_text;
    end;
    if not exists (select 1 from auth.users where id = pinned) then
      raise exception 'jare.owner names % but no such account exists', pinned;
    end if;
    return pinned;
  end if;

  select count(*) into user_count from auth.users;
  if user_count = 0 then
    raise exception 'auth.users is empty; sign in to the app once first';
  elsif user_count > 1 then
    raise exception 'auth.users holds % accounts, so the owner is ambiguous. Pin it once: alter database postgres set jare.owner = ''<uuid>'';', user_count;
  end if;
  select id into owner_id from auth.users;
  return owner_id;
end
$$;

revoke execute on function jare_sole_owner() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. One alert -> one row, with the guards back
-- ---------------------------------------------------------------------------

-- Mirror of CATEGORIES in src/lib/constants.js. Kept here because the
-- function cannot read the bundle; change both together.
create or replace function jare_builtin_categories() returns text[]
language sql
immutable
as $$
  select array[
    'Feeding / Groceries', 'Transport', 'Airtime & Data', 'Electricity', 'Generator', 'Rent', 'Water',
    'Work Expenses', 'Courses & Learning', 'Tools & Software', 'Equipment',
    'Pharmacy', 'Hospital / Clinic', 'Personal Care',
    'Family Support', 'Social Events', 'Church / Mosque', 'Ajo / Esusu',
    'Loan Repayment', 'Bank Charges', 'Savings Transfer', 'Savings', 'Investment',
    'Cash Withdrawal', 'Cash Received', 'Transfer Out', 'Transfer In',
    'Clothing & Fashion', 'Entertainment', 'Dining Out', 'Subscriptions',
    'Repairs', 'Miscellaneous', 'Uncategorized'
  ]
$$;

revoke execute on function jare_builtin_categories() from public, anon, authenticated;

create or replace function ingest_alert_transaction(
  p_source            text,
  p_transaction_id    text,
  p_type              text,
  p_amount            numeric,
  p_date              date,
  p_time              time    default null,
  p_description       text    default null,
  p_recipient         text    default null,
  p_category          text    default 'Uncategorized',
  p_available_balance numeric default null,
  p_raw_excerpt       text    default null,
  p_confidence        text    default 'LOW'
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_owner    uuid := jare_sole_owner();
  v_source   text := lower(trim(coalesce(p_source, '')));
  v_msgid    text := trim(coalesce(p_transaction_id, ''));
  v_txid     text := 'CLA-' || trim(coalesce(p_transaction_id, ''));
  v_type     text := lower(trim(coalesce(p_type, '')));
  v_conf     text := upper(trim(coalesce(p_confidence, 'LOW')));
  v_category text := coalesce(nullif(regexp_replace(trim(coalesce(p_category, '')), '\s+', ' ', 'g'), ''), 'Uncategorized');
  v_desc     text := nullif(left(regexp_replace(trim(coalesce(p_description, '')), '\s+', ' ', 'g'), 500), '');
  v_recip    text := nullif(left(regexp_replace(trim(coalesce(p_recipient, '')), '\s+', ' ', 'g'), 200), '');
  v_excerpt  text := nullif(left(regexp_replace(trim(coalesce(p_raw_excerpt, '')), '\s+', ' ', 'g'), 500), '');
  v_today    date := (now() at time zone 'Africa/Lagos')::date;
  v_flags    text[] := '{}';
  v_wallet   wallets%rowtype;
  v_rule     category_rules%rowtype;
  v_id       uuid;
  v_at       text;
  v_existing uuid;
  v_move     boolean;
begin
  -- Refusals return rather than raise: one odd alert must not roll back the
  -- rest of a batch, and the caller counts them from the reason.
  if v_source = '' then
    return jsonb_build_object('inserted', false, 'reason', 'refused', 'detail', 'p_source (the wallet slug) is required');
  end if;
  if v_msgid = '' then
    return jsonb_build_object('inserted', false, 'reason', 'refused', 'detail', 'p_transaction_id (the Gmail message id) is required');
  end if;
  if v_type not in ('debit', 'credit') then
    return jsonb_build_object('inserted', false, 'reason', 'refused', 'detail', format('p_type must be debit or credit, got %s', p_type));
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('inserted', false, 'reason', 'refused', 'detail', format('p_amount must be positive, got %s', p_amount));
  end if;
  if p_date is null then
    return jsonb_build_object('inserted', false, 'reason', 'refused', 'detail', 'p_date is required');
  end if;
  if v_conf not in ('HIGH', 'LOW') then
    v_conf := 'LOW';
    v_flags := array_append(v_flags, 'confidence_defaulted');
  end if;

  select * into v_wallet
    from wallets
   where user_id = v_owner and source_slug = v_source;
  if not found then
    return jsonb_build_object('inserted', false, 'reason', 'refused',
      'detail', format('no wallet has source_slug %s; known: %s', v_source,
        (select string_agg(source_slug, ', ' order by source_slug) from wallets where user_id = v_owner)));
  end if;

  -- The same message again, whichever wallet it named this time.
  if exists (select 1 from transactions where user_id = v_owner and transaction_id = v_txid) then
    return jsonb_build_object('inserted', false, 'reason', 'duplicate', 'wallet', v_wallet.name);
  end if;

  -- The owner's rules first, by priority then age, as a case-insensitive
  -- substring on the field the rule names: the sync's matchCategoryRule.
  for v_rule in
    select * from category_rules where user_id = v_owner order by priority, created_at
  loop
    if trim(coalesce(v_rule.trigger_value, '')) = '' then continue; end if;
    if (v_rule.trigger_field = 'description' and position(lower(trim(v_rule.trigger_value)) in lower(coalesce(v_desc, ''))) > 0)
       or (v_rule.trigger_field = 'recipient' and position(lower(trim(v_rule.trigger_value)) in lower(coalesce(v_recip, ''))) > 0) then
      v_category := v_rule.action_category;
      v_flags := array_append(v_flags, 'rule:' || v_rule.trigger_field || ' contains ' || trim(v_rule.trigger_value));
      exit;
    end if;
  end loop;

  -- A category the app does not know would be counted as spending under a
  -- name no budget or transfer rule matches; it goes to review instead.
  if not (v_category = any (jare_builtin_categories()))
     and not exists (select 1 from categories where user_id = v_owner and name = v_category) then
    v_flags := array_append(v_flags, 'unknown_category:' || v_category);
    v_category := 'Uncategorized';
    v_conf := 'LOW';
  end if;

  -- A misread account number is a nine-digit "amount". Never auto-reviewed.
  if p_amount > 5000000 then
    v_flags := array_append(v_flags, 'large_amount');
    v_conf := 'LOW';
  end if;

  -- A date ahead of tomorrow is a misread (DD/MM as MM/DD) or a spoof. It is
  -- stored for review, and it never moves a balance.
  if p_date > v_today + 1 then
    v_flags := array_append(v_flags, 'future_date');
    v_conf := 'LOW';
  end if;

  v_move := p_available_balance is not null and p_available_balance >= 0 and p_date <= v_today + 1;
  v_at := p_date::text || 'T' || coalesce(p_time::text, '00:00:00');

  -- The old sync may have imported this same alert under the bank's own
  -- reference or a SYN- hash. Same wallet, day, direction, amount and payee
  -- from such a row is that alert, not a new one. Voided rows and the app's
  -- own MAN- rows are not evidence of an import.
  select id into v_existing
    from transactions
   where user_id = v_owner
     and wallet_id = v_wallet.id
     and transaction_date = p_date
     and type = v_type
     and amount = round(p_amount, 2)
     and coalesce(lower(trim(recipient)), '') = coalesce(lower(v_recip), '')
     and not voided
     and transaction_id not like 'CLA-%'
     and transaction_id not like 'MAN-%'
   limit 1;
  if v_existing is not null then
    if v_move then
      update wallets
         set balance = p_available_balance, balance_as_of = v_at, updated_at = now()
       where id = v_wallet.id and (balance_as_of is null or balance_as_of < v_at);
    end if;
    return jsonb_build_object('inserted', false, 'reason', 'already imported by the old sync',
                              'existing_id', v_existing, 'wallet', v_wallet.name);
  end if;

  insert into transactions
    (user_id, wallet_id, type, amount, currency, source, transaction_id,
     category, description, recipient, transaction_date, transaction_time,
     available_balance, confidence, reviewed, raw_email)
  values
    (v_owner, v_wallet.id, v_type, round(p_amount, 2), 'NGN', v_source, v_txid,
     v_category,
     coalesce(v_desc, v_recip, v_category),
     v_recip,
     p_date, p_time,
     case when p_available_balance is not null and p_available_balance >= 0 then p_available_balance end,
     v_conf, v_conf = 'HIGH',
     v_excerpt)
  on conflict (source, transaction_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('inserted', false, 'reason', 'duplicate', 'wallet', v_wallet.name);
  end if;

  -- Balance from the alert, never backwards (001's balance_as_of), and never
  -- from a date that has not happened.
  if v_move then
    update wallets
       set balance = p_available_balance, balance_as_of = v_at, updated_at = now()
     where id = v_wallet.id
       and (balance_as_of is null or balance_as_of < v_at);
  end if;

  return jsonb_build_object('inserted', true, 'id', v_id, 'wallet', v_wallet.name,
                            'category', v_category, 'reviewed', v_conf = 'HIGH',
                            'flags', to_jsonb(v_flags));
end
$$;

revoke execute on function ingest_alert_transaction(text, text, text, numeric, date, time, text, text, text, numeric, text, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. The run record, with an exact cleanup pattern
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

  if trim(p_job) = 'claude-audit' then
    -- The audit reads the mailbox, so a good run is a mailbox check.
    if p_ok then
      update integrations set last_checked = now() where user_id = v_owner and service = 'gmail';
    end if;
    -- The apply_migration fallback (033) leaves one dated row per day in the
    -- migrations ledger; only those exact names go. A LIKE pattern here once
    -- matched real migration names too.
    if to_regclass('supabase_migrations.schema_migrations') is not null then
      delete from supabase_migrations.schema_migrations where name ~ '^claude_audit_[0-9]{8}$';
    end if;
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
  owner_id      uuid;
  w             uuid;
  r             jsonb;
  bal           numeric;
  run_id        uuid;
  rule_id       uuid;
  saved_checked timestamptz;
  has_ledger    boolean := to_regclass('supabase_migrations.schema_migrations') is not null;
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'week_recaps'
              and (qual = 'true' or with_check = 'true')) then
    raise exception 'week_recaps is still open to every signed-in account';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'week_recaps'
                  and policyname = 'week_recaps_owner') then
    raise exception 'week_recaps_owner policy was not created';
  end if;

  if (select count(*) from auth.users) <> 1 then
    raise notice 'close-out: not exactly one account, function checks skipped';
    return;
  end if;
  owner_id := jare_sole_owner();

  insert into wallets (user_id, name, type, balance, source_slug)
  values (owner_id, '__close_out_check__', 'bank', 1000, 'closeout_check')
  returning id into w;
  select last_checked into saved_checked from integrations where user_id = owner_id and service = 'gmail';

  -- An unknown category lands in review and the balance follows a past alert.
  r := ingest_alert_transaction('closeout_check', 'msg-034-a', 'debit', 250, '2026-09-20', '09:00:00',
                                'POS purchase', 'SHOP', 'Groceries stuff', 750, 'excerpt', 'HIGH');
  if not (r->>'inserted')::boolean or r->>'category' <> 'Uncategorized' or (r->>'reviewed')::boolean then
    raise exception 'unknown category was not downgraded: %', r;
  end if;
  select balance into bal from wallets where id = w;
  if bal <> 750 then raise exception 'balance did not follow the alert: %', bal; end if;

  -- A future date is LOW and leaves the balance alone.
  r := ingest_alert_transaction('closeout_check', 'msg-034-b', 'debit', 10, current_date + 30, '09:00:00',
                                'x', 'y', 'Transport', 5, null, 'HIGH');
  if not (r->>'inserted')::boolean or (r->>'reviewed')::boolean then
    raise exception 'a future-dated alert was auto-reviewed: %', r;
  end if;
  select balance into bal from wallets where id = w;
  if bal <> 750 then raise exception 'a future-dated alert moved the balance to %', bal; end if;

  -- A huge amount is LOW.
  r := ingest_alert_transaction('closeout_check', 'msg-034-c', 'debit', 9000000, '2026-09-20', null,
                                'x', 'y', 'Transport', null, null, 'HIGH');
  if (r->>'reviewed')::boolean then raise exception 'a nine-million alert was auto-reviewed: %', r; end if;

  -- The owner's rule wins over the caller's category.
  insert into category_rules (user_id, trigger_field, trigger_value, action_category, priority)
  values (owner_id, 'recipient', 'closeout fuel station', 'Transport', 0)
  returning id into rule_id;
  r := ingest_alert_transaction('closeout_check', 'msg-034-d', 'debit', 100, '2026-09-20', null,
                                'Card purchase', 'CLOSEOUT FUEL STATION LTD', 'Miscellaneous', null, null, 'HIGH');
  if r->>'category' <> 'Transport' then raise exception 'category rule was not applied: %', r; end if;

  -- A voided old-sync row and an app-logged row are not prior imports.
  insert into transactions (user_id, wallet_id, type, amount, currency, source, transaction_id, category,
                            description, recipient, transaction_date, confidence, reviewed, voided)
  values (owner_id, w, 'debit', 300, 'NGN', 'closeout_check', 'OLDREF-034', 'Transport',
          'old', 'SAME PAYEE', '2026-09-21', 'HIGH', true, true),
         (owner_id, w, 'debit', 400, 'NGN', 'closeout_check', 'MAN-034-check', 'Transport',
          'manual', 'PAYEE TWO', '2026-09-21', 'HIGH', true, false);
  r := ingest_alert_transaction('closeout_check', 'msg-034-e', 'debit', 300, '2026-09-21', null,
                                'new', 'SAME PAYEE', 'Transport', null, null, 'HIGH');
  if not (r->>'inserted')::boolean then raise exception 'a voided old row blocked a real alert: %', r; end if;
  r := ingest_alert_transaction('closeout_check', 'msg-034-f', 'debit', 400, '2026-09-21', null,
                                'new', 'PAYEE TWO', 'Transport', null, null, 'HIGH');
  if not (r->>'inserted')::boolean then raise exception 'an app-logged row blocked a real alert: %', r; end if;

  -- Bad input is refused in the return value, never raised.
  r := ingest_alert_transaction('no_such_wallet', 'msg-034-g', 'debit', 1, '2026-09-20');
  if (r->>'inserted')::boolean or r->>'reason' <> 'refused' then raise exception 'unknown wallet was not refused: %', r; end if;
  r := ingest_alert_transaction('closeout_check', 'msg-034-h', 'debit', 0, '2026-09-20');
  if r->>'reason' <> 'refused' then raise exception 'a zero amount was not refused: %', r; end if;

  -- The same message again is a duplicate.
  r := ingest_alert_transaction('closeout_check', 'msg-034-a', 'debit', 250, '2026-09-20', '09:00:00',
                                'POS purchase', 'SHOP', 'Groceries stuff', 750, 'excerpt', 'HIGH');
  if r->>'reason' <> 'duplicate' then raise exception 'a re-sent message was not a duplicate: %', r; end if;

  -- The run record still writes, and the cleanup pattern is exact.
  if has_ledger then
    insert into supabase_migrations.schema_migrations (version, name)
    values ('00000000000001', 'claude_audit_channel_probe'), ('00000000000002', 'claude_audit_20260101')
    on conflict (version) do update set name = excluded.name;
  end if;
  run_id := record_sync_run('claude-audit', true, 'verify 034');
  if run_id is null then raise exception 'record_sync_run wrote nothing'; end if;
  if has_ledger then
    if not exists (select 1 from supabase_migrations.schema_migrations where version = '00000000000001') then
      raise exception 'cleanup removed a row that is not a dated batch';
    end if;
    if exists (select 1 from supabase_migrations.schema_migrations where version = '00000000000002') then
      raise exception 'cleanup left a dated batch row behind';
    end if;
    delete from supabase_migrations.schema_migrations where version = '00000000000001';
  end if;

  delete from sync_runs where id = run_id;
  update integrations set last_checked = saved_checked where user_id = owner_id and service = 'gmail';
  delete from category_rules where id = rule_id;
  delete from transactions where wallet_id = w;
  delete from wallets where id = w;

  raise notice 'close-out verified: recap policy owner-scoped, ingest guards in place, refusals returned, cleanup exact';
end
$$;
