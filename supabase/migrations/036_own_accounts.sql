-- ============================================================================
-- 036_own_accounts.sql
--
-- Run after 035. Idempotent; safe to re-run.
--
-- Two things the first days of unattended bank-alert ingestion showed:
--
--   1. A transfer to another person was being filed as "Transfer Out". The
--      task's prompt says that category is for a move between the owner's
--      own accounts, but the bank calls every payment a transfer, and the
--      model followed the bank. "Transfer Out" is a TRANSFER_CATEGORIES
--      entry in src/lib/summary.js, so every such row was left out of
--      spending on Budget, Daily HQ and the weekly recap -- sixteen rows
--      and ₦478,800 in the first six days, seven of them auto-reviewed.
--
--      The function now decides for itself. The owner's own names live in
--      jare_owner.own_names (seeded below from the salutation OPay prints on
--      every alert). A transfer-shaped category holds only when the payee
--      -- or, when the alert names no payee, the description -- carries one
--      of those names, or when one of the owner's own category rules chose
--      it. Otherwise the row is filed as Uncategorized at LOW confidence
--      with an explanation, so it waits in the review queue for a real
--      spending category instead of quietly vanishing from the totals.
--      Rows recorded before this file are re-queued the same way, once.
--
--   2. An alert with no stated balance left the wallet where it was. GTBank
--      prints the balance further down the mail than the excerpt reaches,
--      and one omission left GTBank showing ₦11,552 after the transfer that
--      emptied it. When the alert is newer than the wallet's balance_as_of
--      and states no balance, the balance now moves by the amount, the way
--      log_manual_transaction (002) already does; the next stated balance
--      corrects any drift, forward-only as before.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The owner's own names
-- ---------------------------------------------------------------------------

alter table jare_owner add column if not exists own_names text[] not null default '{}';

-- OPay opens every alert with "Dear <account holder>,". The most common
-- such name across the owner's OPay alerts is the owner; nothing here is
-- typed into the repository. Only fills an empty list, so a hand-set list
-- (update jare_owner set own_names = array['...']) is never overwritten.
update jare_owner o
   set own_names = array[s.name]
  from (
    select trim(substring(t.raw_email from '^Dear ([A-Z][A-Z .''-]+),')) as name, count(*) as n
      from transactions t
      join jare_owner j on j.user_id = t.user_id
     where t.source = 'opay'
       and t.raw_email ~ '^Dear [A-Z][A-Z .''-]+,'
     group by 1
     order by n desc
     limit 1
  ) s
 where cardinality(o.own_names) = 0
   and s.n >= 3;

-- True when the text carries one of the owner's names. Case, punctuation
-- and spacing are ignored on both sides, so "ZBN-ADEJARE" matches a name
-- entry "ADEJARE" and "Adejare O. Adelugba" matches "ADEJARE O ADELUGBA".
create or replace function jare_names_own_account(p_text text) returns boolean
language plpgsql
stable
as $$
declare
  v_text  text := trim(regexp_replace(upper(coalesce(p_text, '')), '[^A-Z0-9]+', ' ', 'g'));
  v_name  text;
  v_names text[];
begin
  if v_text = '' then return false; end if;
  select own_names into v_names from jare_owner limit 1;
  foreach v_name in array coalesce(v_names, '{}'::text[]) loop
    v_name := trim(regexp_replace(upper(coalesce(v_name, '')), '[^A-Z0-9]+', ' ', 'g'));
    if v_name <> '' and position(v_name in v_text) > 0 then
      return true;
    end if;
  end loop;
  return false;
end
$$;

revoke execute on function jare_names_own_account(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. ingest_alert_transaction: a transfer must name one of the owner's own
--    accounts; a missing balance moves by the amount
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
  v_wallet   wallets%rowtype;
  v_rule     category_rules%rowtype;
  v_id       uuid;
  v_at       text;
  v_existing uuid;
  v_stated   boolean;
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
      v_by_rule := true;
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

  -- A transfer category says the money is still the owner's, so the app
  -- leaves it out of spending. The alert has to prove that: the payee (or
  -- the description, when no payee was read) must carry one of the owner's
  -- own names, unless the owner's own rule chose the category. A payment
  -- to anyone else is spending whatever the bank calls it, and waits in
  -- review for the owner to say which kind.
  if v_category in ('Transfer Out', 'Transfer In', 'Savings Transfer')
     and not v_by_rule
     and not jare_names_own_account(coalesce(v_recip, v_desc)) then
    v_flags := array_append(v_flags, 'third_party_transfer:' || v_category);
    v_explain := format('Recorded as %s, but %s is not one of your own accounts, so it counts as spending. Pick the category.',
                        v_category, coalesce(v_recip, 'the other party'));
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

  v_stated := p_available_balance is not null and p_available_balance >= 0;
  v_move   := v_stated and p_date <= v_today + 1;
  v_at     := p_date::text || 'T' || coalesce(p_time::text, '00:00:00');

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
     available_balance, confidence, reviewed, raw_email, explanation)
  values
    (v_owner, v_wallet.id, v_type, round(p_amount, 2), 'NGN', v_source, v_txid,
     v_category,
     coalesce(v_desc, v_recip, v_category),
     v_recip,
     p_date, p_time,
     case when v_stated then p_available_balance end,
     v_conf, v_conf = 'HIGH',
     v_excerpt, v_explain)
  on conflict (source, transaction_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('inserted', false, 'reason', 'duplicate', 'wallet', v_wallet.name);
  end if;

  -- Balance from the alert, never backwards (001's balance_as_of), and never
  -- from a date that has not happened. An alert that states no balance but
  -- is newer than what the wallet knows moves it by the amount instead;
  -- the next stated balance overrides that, being later still.
  if v_move then
    update wallets
       set balance = p_available_balance, balance_as_of = v_at, updated_at = now()
     where id = v_wallet.id
       and (balance_as_of is null or balance_as_of < v_at);
  elsif not v_stated and p_date <= v_today + 1 then
    update wallets
       set balance = balance + case when v_type = 'credit' then round(p_amount, 2) else -round(p_amount, 2) end,
           balance_as_of = v_at, updated_at = now()
     where id = v_wallet.id
       and (balance_as_of is null or balance_as_of < v_at);
    if found then
      v_flags := array_append(v_flags, 'balance_derived');
    end if;
  end if;

  return jsonb_build_object('inserted', true, 'id', v_id, 'wallet', v_wallet.name,
                            'category', v_category, 'reviewed', v_conf = 'HIGH',
                            'flags', to_jsonb(v_flags));
end
$$;

revoke execute on function ingest_alert_transaction(text, text, text, numeric, date, time, text, text, text, numeric, text, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Rows recorded before this file, once
-- ---------------------------------------------------------------------------

-- Only while the names are known (an empty list would re-queue the genuine
-- own-account moves too). A row the owner has since re-categorised by hand
-- is left alone: it is no longer a transfer category, or it is LOW and
-- reviewed, which the task never writes.
update transactions t
   set category   = 'Uncategorized',
       confidence = 'LOW',
       reviewed   = false,
       explanation = format('Recorded as %s, but %s is not one of your own accounts, so it counts as spending. Pick the category.',
                            t.category, coalesce(t.recipient, 'the other party'))
 where t.transaction_id like 'CLA-%'
   and not t.voided
   and t.category in ('Transfer Out', 'Transfer In', 'Savings Transfer')
   and (not t.reviewed or t.confidence = 'HIGH')
   and not jare_names_own_account(coalesce(t.recipient, t.description))
   and exists (select 1 from jare_owner where cardinality(own_names) > 0);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id uuid;
  w        uuid;
  r        jsonb;
  bal      numeric;
  as_of    text;
  rule_id  uuid;
  probe    text := '__CLOSEOUT OWNER 036__';
begin
  if not exists (select 1 from information_schema.columns
                  where table_name = 'jare_owner' and column_name = 'own_names') then
    raise exception 'jare_owner.own_names was not added';
  end if;

  if not exists (select 1 from jare_owner) then
    raise notice 'own accounts: no pinned owner yet, function checks skipped';
    return;
  end if;
  owner_id := jare_sole_owner();

  -- A probe name, removed at the end whatever happens below.
  update jare_owner set own_names = array_append(own_names, probe);

  if not jare_names_own_account('transfer to closeout-owner 036') then
    raise exception 'own-name match ignores case and punctuation';
  end if;
  if jare_names_own_account('SOMEONE ELSE ENTIRELY') then
    raise exception 'own-name match accepted a stranger';
  end if;

  insert into wallets (user_id, name, type, balance, source_slug)
  values (owner_id, '__own_accounts_check__', 'bank', 1000, 'ownacct_check')
  returning id into w;

  -- A transfer to a stranger is spending waiting for a category.
  r := ingest_alert_transaction('ownacct_check', 'msg-036-a', 'debit', 250, '2026-09-20', '09:00:00',
                                'Transfer to A Stranger', 'A STRANGER', 'Transfer Out', 750, 'x', 'HIGH');
  if not (r->>'inserted')::boolean or r->>'category' <> 'Uncategorized' or (r->>'reviewed')::boolean
     or not (r->'flags') ? 'third_party_transfer:Transfer Out' then
    raise exception 'a transfer to a stranger kept its transfer category: %', r;
  end if;
  if (select explanation from transactions where id = (r->>'id')::uuid) is null then
    raise exception 'the re-filed row carries no explanation';
  end if;

  -- A transfer to one of the owner's own accounts is what it says.
  r := ingest_alert_transaction('ownacct_check', 'msg-036-b', 'debit', 100, '2026-09-20', '09:10:00',
                                'Transfer to PalmPay', 'CLOSEOUT OWNER 036', 'Savings Transfer', 650, 'x', 'HIGH');
  if r->>'category' <> 'Savings Transfer' or not (r->>'reviewed')::boolean then
    raise exception 'a transfer to the owner was re-filed: %', r;
  end if;

  -- With no payee read, the description decides.
  r := ingest_alert_transaction('ownacct_check', 'msg-036-c', 'debit', 50, '2026-09-20', '09:20:00',
                                'OUTWARD TRANSFER TO OPAY - closeout owner 036', null, 'Transfer Out', 600, 'x', 'HIGH');
  if r->>'category' <> 'Transfer Out' then
    raise exception 'the description was not consulted when no payee was read: %', r;
  end if;

  -- The owner's own rule outranks the check.
  insert into category_rules (user_id, trigger_field, trigger_value, action_category, priority)
  values (owner_id, 'recipient', 'closeout piggy 036', 'Savings Transfer', 0)
  returning id into rule_id;
  r := ingest_alert_transaction('ownacct_check', 'msg-036-d', 'debit', 40, '2026-09-20', '09:30:00',
                                'Transfer', 'CLOSEOUT PIGGY 036 LTD', 'Miscellaneous', 560, 'x', 'HIGH');
  if r->>'category' <> 'Savings Transfer' or not (r->>'reviewed')::boolean then
    raise exception 'the owner''s rule did not outrank the own-account check: %', r;
  end if;

  -- No stated balance: the amount moves the wallet, and only forwards.
  r := ingest_alert_transaction('ownacct_check', 'msg-036-e', 'debit', 60, '2026-09-20', '10:00:00',
                                'POS purchase', 'SHOP', 'Transport', null, 'x', 'HIGH');
  if not (r->'flags') ? 'balance_derived' then raise exception 'a missing balance was not derived: %', r; end if;
  select balance, balance_as_of into bal, as_of from wallets where id = w;
  if bal <> 500 or as_of <> '2026-09-20T10:00:00' then
    raise exception 'derived balance wrong: % as of %', bal, as_of;
  end if;
  r := ingest_alert_transaction('ownacct_check', 'msg-036-f', 'credit', 30, '2026-09-20', '09:50:00',
                                'Older credit', 'SOMEONE', 'Cash Received', null, 'x', 'HIGH');
  if (r->'flags') ? 'balance_derived' then raise exception 'an older alert moved the balance backwards: %', r; end if;
  select balance into bal from wallets where id = w;
  if bal <> 500 then raise exception 'an older alert changed the balance to %', bal; end if;
  r := ingest_alert_transaction('ownacct_check', 'msg-036-g', 'credit', 30, '2026-09-20', '10:30:00',
                                'Newer credit', 'SOMEONE', 'Cash Received', 777, 'x', 'HIGH');
  select balance into bal from wallets where id = w;
  if bal <> 777 then raise exception 'a stated balance did not override the derived one: %', bal; end if;

  delete from category_rules where id = rule_id;
  delete from transactions where wallet_id = w;
  delete from wallets where id = w;
  update jare_owner set own_names = array_remove(own_names, probe);

  raise notice 'own accounts verified: transfers need one of % own name(s), missing balances derive forward-only',
    (select cardinality(own_names) from jare_owner);
exception when others then
  update jare_owner set own_names = array_remove(own_names, probe);
  raise;
end
$$;
