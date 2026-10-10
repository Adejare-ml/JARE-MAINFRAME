-- ============================================================================
-- 039_manual_match_debt_link.sql
--
-- Run after 038. Idempotent; safe to re-run.
--
-- Two ways the ledger disagreed with the bank:
--
--   1. A spend logged by hand (QuickLog, MAN- rows) and then confirmed by
--      the bank's alert the next morning became two rows, and when the
--      alert stated no balance the wallet moved twice: log_manual_transaction
--      (002) had already taken the amount off. The ingest function now
--      looks for a manual entry of the same wallet, direction and amount
--      within a day and, instead of inserting, stamps the alert's message
--      id on it (transactions.alert_message_id, so the same alert is a
--      duplicate next time), fills in the payee, excerpt and stated balance
--      it lacked, and moves the wallet only to a stated balance. This also
--      covers "Log payment" on Debts, which goes through the same RPC.
--
--   2. Repayments were never linked to the debt they repaid: OKash had
--      ₦45,000 of repayments in the ledger and a debt showing ₦0 paid, 25
--      days overdue. debts.match_payee names the payee as the bank prints
--      it; an alert in the repaying direction that carries it is linked
--      (debt_id, 029) and filed as Loan Repayment (or Ajo / Esusu) unless
--      a rule or payee memory already chose. Loans get their counterparty
--      as the default match, and rows already in the ledger are linked once.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table transactions add column if not exists alert_message_id text;
create index if not exists transactions_alert_message_idx on transactions (alert_message_id)
  where alert_message_id is not null;

alter table debts add column if not exists match_payee text;

-- A loan's counterparty is usually what the bank prints ("OKash"); start
-- there, and let the owner refine it on the Debts form.
update debts
   set match_payee = trim(counterparty)
 where match_payee is null
   and kind = 'loan'
   and length(trim(coalesce(counterparty, ''))) >= 4;


-- ---------------------------------------------------------------------------
-- 2. The ingest function
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
    return jsonb_build_object('inserted', false, 'reason', 'refused',
      'detail', format('no wallet has source_slug %s; known: %s', v_source,
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
-- 3. Link what is already there, once
-- ---------------------------------------------------------------------------

update transactions t
   set debt_id = d.id,
       category = case when t.category = 'Uncategorized'
                       then case when d.kind in ('ajo', 'esusu') then 'Ajo / Esusu' else 'Loan Repayment' end
                       else t.category end,
       reviewed = case when t.category = 'Uncategorized' then true else t.reviewed end,
       explanation = case when t.category = 'Uncategorized' then null else t.explanation end
  from debts d
 where t.user_id = d.user_id
   and t.debt_id is null
   and not t.voided
   and not d.settled
   and nullif(trim(coalesce(d.match_payee, '')), '') is not null
   and t.type = case when d.direction = 'owed_to_me' then 'credit' else 'debit' end
   and (position(lower(trim(d.match_payee)) in lower(coalesce(t.recipient, ''))) > 0
     or position(lower(trim(d.match_payee)) in lower(coalesce(t.description, ''))) > 0);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id uuid;
  w        uuid;
  d        uuid;
  m        uuid;
  r        jsonb;
  bal      numeric;
  n        integer;
begin
  if not exists (select 1 from jare_owner) then
    raise notice 'manual match / debt link: no pinned owner yet, function checks skipped';
    return;
  end if;
  owner_id := jare_sole_owner();

  insert into wallets (user_id, name, type, balance, source_slug)
  values (owner_id, '__manual_match_check__', 'bank', 1000, 'manual_check')
  returning id into w;

  -- A manual entry, then its alert: one row, stamped, balance to the stated figure.
  insert into transactions (user_id, wallet_id, type, amount, currency, source, transaction_id, category,
                            description, transaction_date, confidence, reviewed)
  values (owner_id, w, 'debit', 2500, 'NGN', 'manual', 'MAN-039-check', 'Transport',
          'Bolt home', current_date - 1, 'HIGH', true)
  returning id into m;
  update wallets set balance = 7500, balance_as_of = null where id = w;   -- as the manual log left it
  r := ingest_alert_transaction('manual_check', 'msg-039-a', 'debit', 2500, current_date, '08:00:00',
                                'POS BOLT', 'BOLT', 'Transport', 7500, 'x', 'HIGH');
  if r->>'reason' <> 'matched manual entry' or (r->>'existing_id')::uuid <> m then
    raise exception 'the manual entry was not matched: %', r;
  end if;
  select count(*) into n from transactions where wallet_id = w;
  if n <> 1 then raise exception 'a second row was inserted beside the manual entry'; end if;
  if (select alert_message_id from transactions where id = m) <> 'msg-039-a' then
    raise exception 'the alert id was not stamped on the manual entry';
  end if;
  select balance into bal from wallets where id = w;
  if bal <> 7500 then raise exception 'the matched alert moved the balance to %', bal; end if;
  r := ingest_alert_transaction('manual_check', 'msg-039-a', 'debit', 2500, current_date, '08:00:00',
                                'POS BOLT', 'BOLT', 'Transport', 7500, 'x', 'HIGH');
  if r->>'reason' <> 'duplicate' then raise exception 'the stamped alert was not a duplicate next time: %', r; end if;

  -- A repayment to a tracked debt is linked and filed.
  insert into debts (user_id, direction, kind, counterparty, principal, match_payee)
  values (owner_id, 'i_owe', 'loan', '__Probe Lender__', 50000, 'probe lender')
  returning id into d;
  r := ingest_alert_transaction('manual_check', 'msg-039-b', 'debit', 10000, current_date, '09:00:00',
                                'Transfer', 'PROBE LENDER MFB', 'Miscellaneous', 2500, 'x', 'HIGH');
  if (r->>'debt_id')::uuid is distinct from d or r->>'category' <> 'Loan Repayment' or not (r->>'reviewed')::boolean then
    raise exception 'the repayment was not linked: %', r;
  end if;
  -- A credit from the lender is not a repayment of what I owe.
  r := ingest_alert_transaction('manual_check', 'msg-039-c', 'credit', 5000, current_date, '09:30:00',
                                'Disbursement', 'PROBE LENDER MFB', 'Miscellaneous', 7500, 'x', 'HIGH');
  if r->>'debt_id' is not null then raise exception 'a credit was linked to an i_owe debt: %', r; end if;

  delete from transactions where wallet_id = w;
  delete from debts where id = d;
  delete from wallets where id = w;

  raise notice 'manual match and debt link verified';
end
$$;
