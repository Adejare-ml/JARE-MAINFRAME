-- ============================================================================
-- 043_discovered_accounts.sql
--
-- Run after 042. Idempotent; safe to re-run.
--
-- Accounts the mailbox knows about before the app does. The daily audit
-- reads alerts from the senders it has wallets for and skips the rest; a
-- new fintech, a loan app, a second bank account or a cooperative that
-- mails statements stays invisible. This file gives the audit somewhere
-- to put them: one row per sender or slug, with the last balance and
-- date it saw and how many alerts it has seen. The owner then decides,
-- from Daily HQ or Settings: Track (a wallet is created with that slug and
-- sender, so the next alert lands in the ledger) or Ignore (the row stays,
-- muted, and the question is not asked again). The morning push mentions
-- an undecided account on the day it is first seen and weekly after that
-- (src/lib/discovery.js).
--
-- Two ways a row is written, both by the audit running as postgres through
-- the read-write connector:
--   1. ingest_alert_transaction, when it refuses an alert because no wallet
--      has the slug: it now notes the account before refusing.
--   2. note_discovered_account directly, for a sender the task does not
--      even have a slug for (docs/routine-prompt.md, step 2b).
-- `system` names where the sighting came from ('gmail' today), so a later
-- source (SMS forwarding, a bank API) can feed the same table.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table if not exists discovered_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  slug           text not null,
  sender         text,
  label          text,
  system         text not null default 'gmail',
  status         text not null default 'new',
  last_balance   numeric,
  last_seen_on   date,
  last_message_id text,
  times_seen     integer not null default 1,
  first_seen_at  timestamptz not null default now(),
  decided_at     timestamptz,
  wallet_id      uuid references wallets (id) on delete set null,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table discovered_accounts add column if not exists sender          text;
alter table discovered_accounts add column if not exists label           text;
alter table discovered_accounts add column if not exists system          text not null default 'gmail';
alter table discovered_accounts add column if not exists status          text not null default 'new';
alter table discovered_accounts add column if not exists last_balance    numeric;
alter table discovered_accounts add column if not exists last_seen_on    date;
alter table discovered_accounts add column if not exists last_message_id text;
alter table discovered_accounts add column if not exists times_seen      integer not null default 1;
alter table discovered_accounts add column if not exists first_seen_at   timestamptz not null default now();
alter table discovered_accounts add column if not exists decided_at      timestamptz;
alter table discovered_accounts add column if not exists wallet_id       uuid references wallets (id) on delete set null;
alter table discovered_accounts add column if not exists note            text;
alter table discovered_accounts add column if not exists updated_at      timestamptz not null default now();

alter table discovered_accounts drop constraint if exists discovered_accounts_status_check;
alter table discovered_accounts add  constraint discovered_accounts_status_check
  check (status in ('new', 'tracking', 'ignored'));
alter table discovered_accounts drop constraint if exists discovered_accounts_slug_not_blank;
alter table discovered_accounts add  constraint discovered_accounts_slug_not_blank check (length(trim(slug)) > 0);

create unique index if not exists discovered_accounts_owner_slug_idx on discovered_accounts (user_id, slug);

alter table discovered_accounts enable row level security;

-- The owner reads and decides (status, label, note); rows are created by
-- the audit, which runs as postgres and is not bound by RLS.
drop policy if exists discovered_accounts_owner_select on discovered_accounts;
create policy discovered_accounts_owner_select on discovered_accounts
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists discovered_accounts_owner_update on discovered_accounts;
create policy discovered_accounts_owner_update on discovered_accounts
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'discovered_accounts') then
    alter publication supabase_realtime add table discovered_accounts;
  end if;
exception when others then
  raise notice 'discovered_accounts: not added to supabase_realtime (%)', sqlerrm;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. Noting a sighting
--
-- Called by the audit (postgres) for an alert from an account the app has
-- no wallet for. Upserts on (owner, slug): a first sighting makes a 'new'
-- row; a later one bumps times_seen and moves the balance and date forward
-- (never backward: an old mail read late must not overwrite a newer
-- balance). A row the owner has decided on keeps its status; only the
-- figures move, so an ignored account still shows what it last said if the
-- owner ever reopens it.
-- ---------------------------------------------------------------------------

create or replace function note_discovered_account(
  p_slug       text,
  p_sender     text default null,
  p_label      text default null,
  p_balance    numeric default null,
  p_seen_on    date default null,
  p_message_id text default null,
  p_system     text default 'gmail'
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_owner  uuid := jare_sole_owner();
  v_slug   text := lower(regexp_replace(trim(coalesce(p_slug, '')), '[^a-z0-9]', '', 'g'));
  v_sender text := nullif(left(trim(coalesce(p_sender, '')), 120), '');
  v_label  text := nullif(left(regexp_replace(trim(coalesce(p_label, '')), '\s+', ' ', 'g'), 60), '');
  v_seen   date := coalesce(p_seen_on, (now() at time zone 'Africa/Lagos')::date);
  v_row    discovered_accounts%rowtype;
begin
  if v_slug = '' then
    return jsonb_build_object('noted', false, 'reason', 'refused', 'detail', 'a slug (or sender) is required');
  end if;
  if exists (select 1 from wallets where user_id = v_owner and source_slug = v_slug) then
    return jsonb_build_object('noted', false, 'reason', 'already a wallet', 'slug', v_slug);
  end if;

  insert into discovered_accounts (user_id, slug, sender, label, system, last_balance, last_seen_on, last_message_id)
  values (v_owner, v_slug, v_sender, v_label, coalesce(nullif(trim(p_system), ''), 'gmail'),
          case when p_balance is not null and p_balance >= 0 then round(p_balance, 2) end, v_seen, nullif(trim(p_message_id), ''))
  on conflict (user_id, slug) do update
     set times_seen      = discovered_accounts.times_seen + case when discovered_accounts.last_message_id is distinct from excluded.last_message_id then 1 else 0 end,
         sender          = coalesce(discovered_accounts.sender, excluded.sender),
         label           = coalesce(discovered_accounts.label, excluded.label),
         last_balance    = case when excluded.last_seen_on >= coalesce(discovered_accounts.last_seen_on, excluded.last_seen_on) and excluded.last_balance is not null
                                then excluded.last_balance else discovered_accounts.last_balance end,
         last_seen_on    = greatest(discovered_accounts.last_seen_on, excluded.last_seen_on),
         last_message_id = case when excluded.last_seen_on >= coalesce(discovered_accounts.last_seen_on, excluded.last_seen_on)
                                then coalesce(excluded.last_message_id, discovered_accounts.last_message_id) else discovered_accounts.last_message_id end,
         updated_at      = now()
  returning * into v_row;

  return jsonb_build_object('noted', true, 'id', v_row.id, 'slug', v_row.slug, 'status', v_row.status,
                            'times_seen', v_row.times_seen, 'last_balance', v_row.last_balance, 'last_seen_on', v_row.last_seen_on);
end
$$;

revoke execute on function note_discovered_account(text, text, text, numeric, date, text, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The owner's answer: Track makes the wallet; Ignore mutes the row
--
-- SECURITY INVOKER: the owner's own session, RLS on both tables. A wallet is
-- created with the discovered slug and sender, so the next alert from that
-- sender is accepted by ingest_alert_transaction without a prompt change.
-- The balance starts at the last one the mail stated.
-- ---------------------------------------------------------------------------

create or replace function adopt_discovered_account(
  p_id   uuid,
  p_name text default null,
  p_type text default null
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_row    discovered_accounts%rowtype;
  v_wallet uuid;
  v_type   text := coalesce(nullif(trim(p_type), ''), 'bank');
begin
  select * into v_row from discovered_accounts where id = p_id and user_id = auth.uid();
  if not found then
    raise exception 'no discovered account %', p_id;
  end if;
  if v_type not in ('bank', 'mobile', 'savings', 'investment', 'cash') then
    raise exception 'type must be bank, mobile, savings, investment or cash, got %', v_type;
  end if;
  select id into v_wallet from wallets where user_id = auth.uid() and source_slug = v_row.slug;
  if v_wallet is null then
    insert into wallets (user_id, name, type, balance, source_slug, alert_sender, parse_strategy)
    values (auth.uid(), coalesce(nullif(trim(p_name), ''), v_row.label, v_row.slug), v_type,
            coalesce(v_row.last_balance, 0), v_row.slug,
            nullif(regexp_replace(coalesce(v_row.sender, ''), '^.*<([^>]+)>.*$', '\1'), ''), 'llm')
    returning id into v_wallet;
  end if;
  update discovered_accounts
     set status = 'tracking', wallet_id = v_wallet, decided_at = now(), updated_at = now()
   where id = v_row.id;
  return jsonb_build_object('wallet_id', v_wallet, 'slug', v_row.slug);
end
$$;

revoke execute on function adopt_discovered_account(uuid, text, text) from public, anon;
grant  execute on function adopt_discovered_account(uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. The ingest function notes an unknown slug before refusing it
-- ---------------------------------------------------------------------------

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
  v_explain  text;
  v_by_rule  boolean := false;
  v_memory   text;
  v_memory_n integer;
  v_wallet   wallets%rowtype;
  v_rule     category_rules%rowtype;
  v_debt     debts%rowtype;
  v_id       uuid;
  v_at       text;
  v_existing uuid;
  v_manual   uuid;
  v_stated   boolean;
  v_move     boolean;
begin
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
    -- Not a wallet the owner tracks. Remember that this account exists and
    -- what it last said its balance was, so the owner can be asked whether
    -- to track it (043). The alert itself is still refused: nothing lands
    -- in the ledger until the owner says so.
    perform note_discovered_account(v_source, null, nullif(v_desc, ''), p_available_balance, p_date, v_msgid);
    return jsonb_build_object('inserted', false, 'reason', 'refused', 'discovered', true,
      'detail', format('no wallet has source_slug %s (noted as a discovered account; known: %s)', v_source,
        (select string_agg(source_slug, ', ' order by source_slug) from wallets where user_id = v_owner)));
  end if;

  -- The same message again: as its own row, or stamped on a manual entry.
  if exists (select 1 from transactions
              where user_id = v_owner and (transaction_id = v_txid or alert_message_id = v_msgid)) then
    return jsonb_build_object('inserted', false, 'reason', 'duplicate', 'wallet', v_wallet.name);
  end if;

  v_stated := p_available_balance is not null and p_available_balance >= 0;
  v_move   := v_stated and p_date <= v_today + 1;
  v_at     := p_date::text || 'T' || coalesce(p_time::text, '00:00:00');

  -- A manual entry for the same movement: logged in the app before the
  -- bank's alert arrived. It keeps its row and category; the alert fills
  -- in what the owner did not type. The manual log already moved the
  -- wallet by the amount, so only a stated balance moves it again.
  select id into v_manual
    from transactions
   where user_id = v_owner
     and wallet_id = v_wallet.id
     and type = v_type
     and amount = round(p_amount, 2)
     and transaction_id like 'MAN-%'
     and alert_message_id is null
     and not voided
     and transaction_date between p_date - 1 and p_date + 1
   order by abs(transaction_date - p_date), created_at desc
   limit 1;
  if v_manual is not null then
    update transactions
       set alert_message_id  = v_msgid,
           recipient         = coalesce(recipient, v_recip),
           raw_email         = coalesce(raw_email, v_excerpt),
           available_balance = case when v_stated then p_available_balance else available_balance end,
           explanation       = coalesce(explanation, format('Matched the bank alert of %s', p_date))
     where id = v_manual;
    if v_move then
      update wallets
         set balance = p_available_balance, balance_as_of = v_at, updated_at = now()
       where id = v_wallet.id and (balance_as_of is null or balance_as_of <= v_at);
    end if;
    return jsonb_build_object('inserted', false, 'reason', 'matched manual entry',
                              'existing_id', v_manual, 'wallet', v_wallet.name);
  end if;

  for v_rule in
    select * from category_rules
     where user_id = v_owner
     order by priority, length(trim(trigger_value)) desc, created_at desc
  loop
    if trim(coalesce(v_rule.trigger_value, '')) = '' then continue; end if;
    if (v_rule.trigger_field = 'description' and position(lower(trim(v_rule.trigger_value)) in lower(coalesce(v_desc, ''))) > 0)
       or (v_rule.trigger_field = 'recipient' and position(lower(trim(v_rule.trigger_value)) in lower(coalesce(v_recip, ''))) > 0) then
      v_category := v_rule.action_category;
      v_by_rule := true;
      v_flags := array_append(v_flags, 'rule:' || v_rule.trigger_field || ' contains ' || trim(v_rule.trigger_value));
      exit;
    end if;
  end loop;

  if not v_by_rule and v_recip is not null then
    select count(*), min(corrected_category)
      into v_memory_n, v_memory
      from (
        select corrected_category
          from category_corrections
         where user_id = v_owner
           and lower(trim(coalesce(recipient, ''))) = lower(v_recip)
           and corrected_category <> 'Uncategorized'
         order by created_at desc
         limit 3
      ) recent;
    if v_memory_n >= 2
       and (select count(distinct corrected_category) from (
              select corrected_category from category_corrections
               where user_id = v_owner
                 and lower(trim(coalesce(recipient, ''))) = lower(v_recip)
                 and corrected_category <> 'Uncategorized'
               order by created_at desc limit 3) r) = 1 then
      v_category := v_memory;
      v_conf := 'HIGH';
      v_by_rule := true;
      v_flags := array_append(v_flags, 'payee_memory:' || v_memory);
    end if;
  end if;

  if not (v_category = any (jare_builtin_categories()))
     and not exists (select 1 from categories where user_id = v_owner and name = v_category) then
    v_flags := array_append(v_flags, 'unknown_category:' || v_category);
    v_category := 'Uncategorized';
    v_conf := 'LOW';
  end if;

  if v_category in ('Transfer Out', 'Transfer In', 'Savings Transfer')
     and not v_by_rule
     and not jare_names_own_account(coalesce(v_recip, v_desc)) then
    v_flags := array_append(v_flags, 'third_party_transfer:' || v_category);
    v_explain := format('Recorded as %s, but %s is not one of your own accounts, so it counts as %s. Pick the category.',
                        v_category, coalesce(v_recip, 'the other party'),
                        case when v_type = 'credit' then 'income' else 'spending' end);
    v_category := 'Uncategorized';
    v_conf := 'LOW';
  end if;

  -- A repayment of a debt the owner tracks: the payee the bank prints is on
  -- the debt, and the money is moving in the repaying direction.
  select d.* into v_debt
    from debts d
   where d.user_id = v_owner
     and not d.settled
     and nullif(trim(coalesce(d.match_payee, '')), '') is not null
     and v_type = case when d.direction = 'owed_to_me' then 'credit' else 'debit' end
     and (position(lower(trim(d.match_payee)) in lower(coalesce(v_recip, ''))) > 0
       or position(lower(trim(d.match_payee)) in lower(coalesce(v_desc, ''))) > 0)
   order by length(trim(d.match_payee)) desc, d.created_at
   limit 1;
  if v_debt.id is not null then
    if not v_by_rule then
      v_category := case when v_debt.kind in ('ajo', 'esusu') then 'Ajo / Esusu' else 'Loan Repayment' end;
      v_conf := 'HIGH';
      v_explain := null;
    end if;
    v_flags := array_append(v_flags, 'debt:' || coalesce(v_debt.counterparty, ''));
  end if;

  if p_amount > 5000000 then
    v_flags := array_append(v_flags, 'large_amount');
    v_conf := 'LOW';
  end if;

  if p_date > v_today + 1 then
    v_flags := array_append(v_flags, 'future_date');
    v_conf := 'LOW';
  end if;

  if p_date < v_today - 10 then
    v_flags := array_append(v_flags, 'stale_date');
    v_conf := 'LOW';
  end if;

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
       where id = v_wallet.id and (balance_as_of is null or balance_as_of <= v_at);
    end if;
    return jsonb_build_object('inserted', false, 'reason', 'already imported by the old sync',
                              'existing_id', v_existing, 'wallet', v_wallet.name);
  end if;

  insert into transactions
    (user_id, wallet_id, type, amount, currency, source, transaction_id,
     category, description, recipient, transaction_date, transaction_time,
     available_balance, confidence, reviewed, raw_email, explanation, debt_id)
  values
    (v_owner, v_wallet.id, v_type, round(p_amount, 2), 'NGN', v_source, v_txid,
     v_category,
     coalesce(v_desc, v_recip, v_category),
     v_recip,
     p_date, p_time,
     case when v_stated then p_available_balance end,
     v_conf, v_conf = 'HIGH',
     v_excerpt, v_explain, v_debt.id)
  on conflict (source, transaction_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('inserted', false, 'reason', 'duplicate', 'wallet', v_wallet.name);
  end if;

  if v_move then
    update wallets
       set balance = p_available_balance, balance_as_of = v_at, updated_at = now()
     where id = v_wallet.id
       and (balance_as_of is null or balance_as_of <= v_at);
  elsif not v_stated and p_date <= v_today + 1 then
    update wallets
       set balance = balance + case when v_type = 'credit' then round(p_amount, 2) else -round(p_amount, 2) end,
           balance_as_of = v_at, updated_at = now()
     where id = v_wallet.id
       and (balance_as_of is null or balance_as_of <= v_at);
    if found then
      v_flags := array_append(v_flags, 'balance_derived');
    end if;
  end if;

  return jsonb_build_object('inserted', true, 'id', v_id, 'wallet', v_wallet.name,
                            'category', v_category, 'reviewed', v_conf = 'HIGH',
                            'debt_id', v_debt.id, 'flags', to_jsonb(v_flags));
end
$$;

revoke execute on function ingest_alert_transaction(text, text, text, numeric, date, time, text, text, text, numeric, text, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id uuid;
  r        jsonb;
  d        uuid;
  w        uuid;
begin
  if not exists (select 1 from jare_owner) then
    raise notice 'discovered accounts: no pinned owner yet, function checks skipped';
    return;
  end if;
  owner_id := jare_sole_owner();

  -- An alert from an unknown slug is refused and noted.
  r := ingest_alert_transaction('probe043', 'msg-043-a', 'credit', 500, current_date, '09:00:00',
                                'Salary', 'EMPLOYER', 'Cash Received', 12400, 'x', 'HIGH');
  if r->>'reason' <> 'refused' or not (r->>'discovered')::boolean then
    raise exception 'unknown slug was not noted: %', r;
  end if;
  select id into d from discovered_accounts where user_id = owner_id and slug = 'probe043';
  if d is null then raise exception 'no discovered row'; end if;
  if (select last_balance from discovered_accounts where id = d) <> 12400 then raise exception 'balance not kept'; end if;

  -- A second, older mail does not move the balance back; a newer one does.
  perform note_discovered_account('probe043', 'Probe <alerts@probe043.com>', null, 100, current_date - 5, 'msg-043-old');
  if (select last_balance from discovered_accounts where id = d) <> 12400 then raise exception 'old mail moved the balance back'; end if;
  perform note_discovered_account('probe043', null, null, 15000, current_date, 'msg-043-b');
  if (select last_balance from discovered_accounts where id = d) <> 15000 then raise exception 'new mail did not move the balance'; end if;
  if (select times_seen from discovered_accounts where id = d) <> 3 then
    raise exception 'times_seen is %', (select times_seen from discovered_accounts where id = d);
  end if;
  if (select sender from discovered_accounts where id = d) is null then raise exception 'sender not kept'; end if;

  -- Tracking makes the wallet, with the sender address and the last balance,
  -- and the next alert lands.
  insert into wallets (user_id, name, type, balance, source_slug, alert_sender, parse_strategy)
  values (owner_id, 'Probe 043', 'mobile', 15000, 'probe043', 'alerts@probe043.com', 'llm') returning id into w;
  update discovered_accounts set status = 'tracking', wallet_id = w, decided_at = now() where id = d;
  r := ingest_alert_transaction('probe043', 'msg-043-c', 'debit', 200, current_date, '10:00:00',
                                'POS', 'SHOP', 'Feeding / Groceries', 14800, 'x', 'HIGH');
  if not (r->>'inserted')::boolean then raise exception 'alert after tracking was not inserted: %', r; end if;
  r := note_discovered_account('probe043', null, null, 1, current_date, 'msg-043-d');
  if (r->>'noted')::boolean then raise exception 'a tracked slug was noted again'; end if;

  delete from transactions where wallet_id = w;
  delete from discovered_accounts where id = d;
  delete from wallets where id = w;
  raise notice 'discovered accounts verified: noted on refusal, balance moves forward only, tracking makes the wallet';
end
$$;
