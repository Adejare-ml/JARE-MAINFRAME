-- ============================================================================
-- 038_self_categorising.sql
--
-- Run after 037. Idempotent; safe to re-run.
--
-- Twelve days of unattended ingestion (28 Sep to 10 Oct 2026) left 68 rows
-- in the review queue and no category rule. The queue, not the pipeline,
-- is the bottleneck, so the ingest function has to need the owner less:
--
--   1. The own-name check (036) matched the whole name as one string.
--      GTBank prints the name truncated ("ADEJARE OLUWAGBEMILEKE") and
--      OPay prints it with a bank prefix, so genuine own-account moves
--      were re-filed as spending. It now matches on whole words: the full
--      name, or any two adjacent words of it. "ADE" no longer matches
--      "SHADE" either.
--   2. Rules all carry priority 0, so the oldest broad rule beat a newer
--      specific one for good. Ties now go to the longer value, then the
--      newer rule.
--   3. Payee memory: when the owner has corrected the same payee to the
--      same category twice (category_corrections, 005), the next alert
--      from that payee gets it at HIGH. The owner's decisions only; the
--      task's own guesses never feed back into themselves.
--   4. Two rules the data asked for are seeded: GTBank card top-ups into
--      OPay ("WEB PUR … OPAY CHARGE") are moves between own accounts, and
--      OKash transfers are loan repayments.
--   5. A date more than ten days in the past is a misread as often as a
--      late alert (DD/MM swapped, wrong year) and used to land in an old
--      month at HIGH. It is LOW now, flagged stale_date.
--   6. Two alerts with the same timestamp (untimed, or the same second)
--      moved the balance once. The forward-only compare allows equality.
--   7. The "counts as spending" explanation was wrong for a credit.
--
-- Rows already waiting that the new checks resolve are healed once.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Own-name match on whole words, full name or two adjacent words
-- ---------------------------------------------------------------------------

create or replace function jare_names_own_account(p_text text) returns boolean
language plpgsql
stable
as $$
declare
  v_text  text := ' ' || trim(regexp_replace(upper(coalesce(p_text, '')), '[^A-Z0-9]+', ' ', 'g')) || ' ';
  v_name  text;
  v_names text[];
  v_words text[];
  i       integer;
begin
  if trim(v_text) = '' then return false; end if;
  select own_names into v_names from jare_owner limit 1;
  foreach v_name in array coalesce(v_names, '{}'::text[]) loop
    v_name := trim(regexp_replace(upper(coalesce(v_name, '')), '[^A-Z0-9]+', ' ', 'g'));
    if v_name = '' then continue; end if;
    if position(' ' || v_name || ' ' in v_text) > 0 then
      return true;
    end if;
    -- A truncated or prefixed print still carries two of the name's words
    -- side by side: "ADEJARE OLUWAGBEMILEKE" from GTBank, "OPAY ADEJARE
    -- OLUWAGBEMILEKE ADELUGBA" from a transfer receipt.
    v_words := string_to_array(v_name, ' ');
    for i in 1 .. coalesce(array_length(v_words, 1), 0) - 1 loop
      if length(v_words[i]) >= 3 and length(v_words[i + 1]) >= 3
         and position(' ' || v_words[i] || ' ' || v_words[i + 1] || ' ' in v_text) > 0 then
        return true;
      end if;
    end loop;
  end loop;
  return false;
end
$$;

revoke execute on function jare_names_own_account(text) from public, anon, authenticated;


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
  v_id       uuid;
  v_at       text;
  v_existing uuid;
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

  if exists (select 1 from transactions where user_id = v_owner and transaction_id = v_txid) then
    return jsonb_build_object('inserted', false, 'reason', 'duplicate', 'wallet', v_wallet.name);
  end if;

  -- The owner's rules: by priority, then the longer (more specific) value,
  -- then the newer rule, so "OPAY JOHN" beats an older "OPAY".
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

  -- Payee memory: the owner corrected this payee to the same category at
  -- least twice, most recently. Owner decisions only (category_corrections
  -- is written by the review screens, never by this function).
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

  -- A transfer category says the money is still the owner's. The alert has
  -- to prove it, unless the owner's rule or memory chose the category.
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

  if p_amount > 5000000 then
    v_flags := array_append(v_flags, 'large_amount');
    v_conf := 'LOW';
  end if;

  if p_date > v_today + 1 then
    v_flags := array_append(v_flags, 'future_date');
    v_conf := 'LOW';
  end if;

  -- A date well in the past is a swapped DD/MM or a wrong year as often as
  -- a late alert; it would land in an old month's totals unseen.
  if p_date < v_today - 10 then
    v_flags := array_append(v_flags, 'stale_date');
    v_conf := 'LOW';
  end if;

  v_stated := p_available_balance is not null and p_available_balance >= 0;
  v_move   := v_stated and p_date <= v_today + 1;
  v_at     := p_date::text || 'T' || coalesce(p_time::text, '00:00:00');

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

  -- Forward-only, equality allowed: two alerts in the same second, or two
  -- untimed alerts on one day, both move the wallet.
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
                            'flags', to_jsonb(v_flags));
end
$$;

revoke execute on function ingest_alert_transaction(text, text, text, numeric, date, time, text, text, text, numeric, text, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Two rules the first twelve days asked for
-- ---------------------------------------------------------------------------

insert into category_rules (user_id, trigger_field, trigger_value, action_category, priority)
select o.user_id, r.field, r.value, r.category, 0
  from jare_owner o
  cross join (values
    ('description', 'OPAY CHARGE', 'Transfer Out'),   -- GTBank card top-up into the owner's OPay
    ('recipient',   'OKash',       'Loan Repayment')
  ) as r(field, value, category)
 where not exists (
   select 1 from category_rules c
    where c.user_id = o.user_id and c.trigger_field = r.field
      and lower(trim(c.trigger_value)) = lower(r.value)
 );


-- ---------------------------------------------------------------------------
-- 4. Heal the queue once
-- ---------------------------------------------------------------------------

-- Rows 036 re-filed whose payee now passes the own-name check get their
-- original category back.
update transactions t
   set category = substring(t.explanation from '^Recorded as (.+?), but '),
       confidence = 'HIGH', reviewed = true, explanation = null
 where t.transaction_id like 'CLA-%'
   and not t.voided and not t.reviewed
   and t.category = 'Uncategorized'
   and t.explanation like 'Recorded as %, but %'
   and substring(t.explanation from '^Recorded as (.+?), but ') in ('Transfer Out', 'Transfer In', 'Savings Transfer')
   and jare_names_own_account(coalesce(t.recipient, t.description));

-- Waiting rows a rule now covers are filed by it.
update transactions t
   set category = r.action_category, reviewed = true,
       explanation = format('Filed by your rule: %s contains "%s"', r.trigger_field, r.trigger_value)
  from (
    select distinct on (c.user_id, c.trigger_field, lower(trim(c.trigger_value))) c.*
      from category_rules c
     order by c.user_id, c.trigger_field, lower(trim(c.trigger_value)), c.priority, c.created_at desc
  ) r
 where t.user_id = r.user_id
   and t.transaction_id like 'CLA-%'
   and not t.voided and not t.reviewed
   and ((r.trigger_field = 'description' and position(lower(trim(r.trigger_value)) in lower(coalesce(t.description, ''))) > 0)
     or (r.trigger_field = 'recipient'   and position(lower(trim(r.trigger_value)) in lower(coalesce(t.recipient, ''))) > 0));


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  owner_id uuid;
  w        uuid;
  r        jsonb;
  bal      numeric;
  probe    text := '__CLOSEOUT OWNER THIRTYEIGHT__';
  rule_a   uuid;
  rule_b   uuid;
begin
  if not exists (select 1 from jare_owner) then
    raise notice 'self-categorising: no pinned owner yet, function checks skipped';
    return;
  end if;
  owner_id := jare_sole_owner();
  update jare_owner set own_names = array_append(own_names, probe);

  -- Whole name, two adjacent words, but never a fragment inside a word.
  if not jare_names_own_account('OPAY - closeout owner thirtyeight') then raise exception 'full name not matched'; end if;
  if not jare_names_own_account('OUTWARD TRANSFER TO OPAY - CLOSEOUT OWNER') then raise exception 'two adjacent words not matched'; end if;
  if jare_names_own_account('SHADE CLOSEOUT') then raise exception 'a single word matched'; end if;
  if jare_names_own_account('THIRTYEIGHT OWNER CLOSEOUT') then raise exception 'reordered words matched'; end if;

  insert into wallets (user_id, name, type, balance, source_slug)
  values (owner_id, '__self_cat_check__', 'bank', 1000, 'selfcat_check')
  returning id into w;

  -- The longer rule wins over an older, broader one.
  insert into category_rules (user_id, trigger_field, trigger_value, action_category, priority)
  values (owner_id, 'recipient', 'selfcat probe', 'Miscellaneous', 0) returning id into rule_a;
  insert into category_rules (user_id, trigger_field, trigger_value, action_category, priority)
  values (owner_id, 'recipient', 'selfcat probe shop', 'Feeding / Groceries', 0) returning id into rule_b;
  r := ingest_alert_transaction('selfcat_check', 'msg-038-a', 'debit', 100, current_date, '09:00:00',
                                'POS', 'SELFCAT PROBE SHOP LTD', 'Transport', 900, 'x', 'HIGH');
  if r->>'category' <> 'Feeding / Groceries' then raise exception 'the specific rule did not win: %', r; end if;

  -- Payee memory: two corrections to the same category file the next one HIGH.
  insert into category_corrections (user_id, recipient, description_snippet, corrected_category)
  values (owner_id, 'SELFCAT MEMORY PAYEE', 'x', 'Family Support'),
         (owner_id, 'selfcat memory payee', 'y', 'Family Support');
  r := ingest_alert_transaction('selfcat_check', 'msg-038-b', 'debit', 50, current_date, '09:10:00',
                                'Transfer', 'SELFCAT MEMORY PAYEE', 'Transfer Out', 850, 'x', 'LOW');
  if r->>'category' <> 'Family Support' or not (r->>'reviewed')::boolean then
    raise exception 'payee memory was not applied: %', r;
  end if;

  -- A stale date is LOW.
  r := ingest_alert_transaction('selfcat_check', 'msg-038-c', 'debit', 10, current_date - 30, null,
                                'x', 'SOMEONE', 'Transport', null, 'x', 'HIGH');
  if (r->>'reviewed')::boolean or not (r->'flags') ? 'stale_date' then raise exception 'a stale date was auto-reviewed: %', r; end if;

  -- Two untimed alerts on one day both move the balance.
  update wallets set balance = 1000, balance_as_of = null where id = w;
  r := ingest_alert_transaction('selfcat_check', 'msg-038-d', 'debit', 100, current_date, null, 'a', 'A', 'Transport', null, 'x', 'HIGH');
  r := ingest_alert_transaction('selfcat_check', 'msg-038-e', 'debit', 100, current_date, null, 'b', 'B', 'Transport', null, 'x', 'HIGH');
  if not (r->'flags') ? 'balance_derived' then raise exception 'the second untimed alert did not move the balance: %', r; end if;
  select balance into bal from wallets where id = w;
  if bal <> 800 then raise exception 'two untimed alerts left the balance at %', bal; end if;

  -- A credit to a stranger says income, not spending.
  r := ingest_alert_transaction('selfcat_check', 'msg-038-f', 'credit', 70, current_date, '10:00:00',
                                'Transfer from A Stranger', 'A STRANGER', 'Transfer In', null, 'x', 'HIGH');
  if (select explanation from transactions where id = (r->>'id')::uuid) not like '%counts as income%' then
    raise exception 'credit explanation still says spending';
  end if;

  delete from category_corrections where user_id = owner_id and lower(recipient) = 'selfcat memory payee';
  delete from category_rules where id in (rule_a, rule_b);
  delete from transactions where wallet_id = w;
  delete from wallets where id = w;
  update jare_owner set own_names = array_remove(own_names, probe);

  raise notice 'self-categorising verified: whole-word own names, specific rules first, payee memory, stale dates, balance ties';
exception when others then
  update jare_owner set own_names = array_remove(own_names, probe);
  raise;
end
$$;
