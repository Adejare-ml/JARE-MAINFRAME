-- ============================================================================
-- 048_discovery_followups.sql
--
-- Run after 047. Idempotent; safe to re-run.
--
-- Three follow-ups to the accounts-discovered-in-mail feature (043), from
-- the council review of 18 Oct:
--
-- 1. No sighting from a refusal. ingest_alert_transaction noted any unknown
--    slug as a discovered account before refusing it, so a Routine typo
--    (gt-bank) minted a junk account and a junk question for the owner.
--    Sightings now come only from the explicit note_discovered_account call
--    in prompt step 2b, and the refusal names the nearest known slug.
-- 2. asked_at and snooze_until. "Ask again next week" was a date computed
--    from first_seen_at; it is now a column the reminder stamps when it
--    asks, and a snooze the owner can set from the card.
-- 3. A statement from an account that is already a wallet carries a
--    balance worth keeping: note_discovered_account now records it on the
--    wallet (forward only, never over a newer alert) and answers
--    balance_noted instead of a bare "already a wallet".
--
-- ingest_alert_transaction is redefined in full from 046's body with only
-- the refusal branch changed.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table discovered_accounts add column if not exists asked_at     timestamptz;
alter table discovered_accounts add column if not exists snooze_until date;


-- ---------------------------------------------------------------------------
-- 2. The nearest known slug, for a refusal that can correct itself
-- ---------------------------------------------------------------------------

create or replace function jare_nearest_slug(p_owner uuid, p_slug text) returns text
language sql
stable
as $$
  -- Compared on letters and digits only: "gt-bank" and "GT Bank" both mean gtbank.
  with given as (
    select lower(regexp_replace(coalesce(p_slug, ''), '[^A-Za-z0-9]', '', 'g')) as s
  ), known as (
    select source_slug as slug from wallets where user_id = p_owner and coalesce(source_slug, '') <> ''
  ), scored as (
    select k.slug,
           case
             when k.slug = g.s then 100
             when g.s <> '' and (position(k.slug in g.s) > 0 or position(g.s in k.slug) > 0) then 50 + least(length(k.slug), length(g.s))
             else (select count(*)::int from generate_series(1, least(length(k.slug), length(g.s))) i
                    where left(k.slug, i) = left(g.s, i))
           end as score
      from known k cross join given g
  )
  select slug from scored where score >= 3 order by score desc, slug limit 1;
$$;

revoke execute on function jare_nearest_slug(uuid, text) from public, anon;


-- ---------------------------------------------------------------------------
-- 3. note_discovered_account: a tracked slug keeps its stated balance
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
  v_wallet wallets%rowtype;
  v_moved  boolean := false;
begin
  if v_slug = '' then
    return jsonb_build_object('noted', false, 'reason', 'refused', 'detail', 'a slug (or sender) is required');
  end if;

  select * into v_wallet from wallets where user_id = v_owner and source_slug = v_slug;
  if found then
    -- A statement or balance mail from an account already tracked: keep
    -- the balance, forward only. A day-dated mail never overrides an alert
    -- stamped the same day or later (036's rule), and a derived balance
    -- older than the statement is corrected by it.
    if p_balance is not null and p_balance >= 0
       and (v_wallet.balance_as_of is null or left(v_wallet.balance_as_of, 10) < v_seen::text) then
      update wallets
         set balance = round(p_balance, 2), balance_as_of = v_seen::text || 'T00:00:00', updated_at = now()
       where id = v_wallet.id;
      v_moved := true;
    end if;
    return jsonb_build_object('noted', false, 'reason', 'already a wallet', 'slug', v_slug,
                              'wallet', v_wallet.name, 'balance_noted', v_moved);
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
-- 4. The ingest function, refusing without noting
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
    -- Not a wallet the owner tracks. 043 noted it as a discovered account
    -- here; 048 stopped that, because a Routine typo such as gt-bank minted
    -- a junk account and a junk question. Sightings come only from the
    -- explicit note_discovered_account call (prompt step 2b); the refusal
    -- names the nearest known slug so the next run can correct itself.
    return jsonb_build_object('inserted', false, 'reason', 'refused', 'discovered', false,
      'nearest', jare_nearest_slug(v_owner, v_source),
      'detail', format('no wallet has source_slug %s%s (known: %s)', v_source,
        coalesce(format('; did you mean %s?', jare_nearest_slug(v_owner, v_source)), ''),
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
  --
  -- 046: the payee has to agree when both sides name one. A QuickLog of
  -- N1,000 airtime ("MTN top-up") used to swallow Monday's unrelated
  -- N1,000 POS alert, which then never reached the ledger and showed up
  -- weeks later as a reconcile gap. The manual side's payee is its note
  -- (QuickLog has no recipient field; its description falls back to the
  -- category name, which is not a payee); a manual row with no note still
  -- matches as before. The same day wins over the day either side, and a
  -- row whose payee agrees wins over one that merely has none.
  select t.id into v_manual
    from transactions t
   where t.user_id = v_owner
     and t.wallet_id = v_wallet.id
     and t.type = v_type
     and t.amount = round(p_amount, 2)
     and t.transaction_id like 'MAN-%'
     and t.alert_message_id is null
     and not t.voided
     and t.transaction_date between p_date - 1 and p_date + 1
     and (nullif(trim(coalesce(t.recipient, t.note, '')), '') is null
          or coalesce(v_recip, v_desc) is null
          or jare_texts_share_word(coalesce(t.recipient, t.note), coalesce(v_recip, v_desc)))
   order by abs(t.transaction_date - p_date),
            (nullif(trim(coalesce(t.recipient, t.note, '')), '') is not null) desc,
            t.created_at desc
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
  w        uuid;
  r        jsonb;
begin
  if not exists (select 1 from information_schema.columns where table_name = 'discovered_accounts' and column_name = 'snooze_until') then
    raise exception 'snooze_until was not added';
  end if;
  if not exists (select 1 from jare_owner) then
    raise notice 'discovery follow-ups: no pinned owner yet, function checks skipped';
    return;
  end if;
  owner_id := jare_sole_owner();

  insert into wallets (user_id, name, type, balance, source_slug)
  values (owner_id, '__probe048__', 'bank', 1000, 'probe048') returning id into w;

  -- 1. A typo is refused, not noted, and the nearest slug is named.
  r := ingest_alert_transaction('probe-048', 'msg-048-a', 'debit', 10, current_date, '09:00:00', 'x', 'y', 'Transport', 990, 'x', 'HIGH');
  if r->>'reason' <> 'refused' or (r->>'discovered')::boolean then raise exception 'typo was not refused cleanly: %', r; end if;
  if r->>'nearest' <> 'probe048' then raise exception 'nearest slug not named: %', r; end if;
  if exists (select 1 from discovered_accounts where user_id = owner_id and slug = 'probe048') then
    raise exception 'a refusal still minted a discovered account';
  end if;

  -- 3. A statement for a tracked slug keeps the balance, forward only.
  r := note_discovered_account('probe048', null, null, 5000, current_date - 1, 'msg-048-b');
  if (r->>'noted')::boolean or not (r->>'balance_noted')::boolean then raise exception 'statement balance not noted: %', r; end if;
  if (select balance from wallets where id = w) <> 5000 then raise exception 'wallet balance not set from the statement'; end if;
  r := note_discovered_account('probe048', null, null, 100, current_date - 10, 'msg-048-c');
  if (r->>'balance_noted')::boolean then raise exception 'an older statement moved the balance back'; end if;
  if (select balance from wallets where id = w) <> 5000 then raise exception 'older statement changed the balance'; end if;

  -- The explicit call still notes an unknown account.
  r := note_discovered_account('probe048new', 'alerts@probe048new.com', 'Probe New', 20, current_date, 'msg-048-d');
  if not (r->>'noted')::boolean then raise exception 'explicit note failed: %', r; end if;

  delete from discovered_accounts where user_id = owner_id and slug = 'probe048new';
  delete from wallets where id = w;
  raise notice 'discovery follow-ups verified: refusals do not note, nearest slug named, statement balances kept';
end
$$;
