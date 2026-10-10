-- ============================================================================
-- 041_more_banks.sql
--
-- Run after 040. Idempotent; safe to re-run.
--
-- Three more senders for the daily audit: PalmPay, Zenith and PiggyVest.
-- All three have mailed alerts for months (PalmPay held ₦30,800 the app
-- could not see in the last week of September) and the ingest function
-- needs nothing new for them -- only a wallet per slug, which this creates
-- for the pinned owner when missing, with the sender address each one
-- writes from. Balances start at zero; the owner sets PiggyVest's by hand
-- (its mails never state one), the other two follow their first alert.
--
-- What the mails look like, so the prompt and the rules below make sense:
--   PalmPay   "Transfer Successful" (debit, recipient named, no balance) and
--             "Receive Transfer" (credit, "Your available balance is now").
--             Salutation "Dear ADEJARE ADELUGBA" -- two names, so that short
--             form is added to own_names, with the reversed order Zenith
--             prints on an inbound transfer ("ADELUGBA ADEJARE ...").
--   Zenith    "ZENITH BANK TRANSACTION ALERT[DEBIT:NGN36,200.00]" with a
--             Description row and Available Balance. The bank also sends a
--             "PAYMENT RECEIPT TO (...)" for the same debit: a duplicate,
--             which the prompt skips.
--   PiggyVest "₦5,500 has been added to your Flex wallet" (credit) and
--             "₦-6,755.00 has left your Piggybank Savings" (debit), a Memo
--             line and no balance. Interest arrives as a credit with the
--             memo "... Monthly Interest Payment"; a withdrawal's memo is
--             "Withdrawal Made" with no payee, which the own-name check
--             would file for review every time, so a rule names it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Wallets, one per slug, for the pinned owner
-- ---------------------------------------------------------------------------

insert into wallets (user_id, name, type, balance, source_slug, alert_sender, parse_strategy)
select o.user_id, w.name, w.type, 0, w.slug, w.sender, 'llm'
  from jare_owner o
  cross join (values
    ('PalmPay',   'mobile',  'palmpay',   'no-reply@palmpay.com'),
    ('Zenith',    'bank',    'zenith',    'ebusinessgroup@zenithbank.com'),
    ('PiggyVest', 'savings', 'piggyvest', 'contact@piggyvest.com')
  ) as w(name, type, slug, sender)
 where not exists (select 1 from wallets x where x.user_id = o.user_id and x.source_slug = w.slug);

-- A wallet made by hand under the same slug gets the sender filled in.
update wallets w
   set alert_sender = s.sender
  from (values ('palmpay', 'no-reply@palmpay.com'), ('zenith', 'ebusinessgroup@zenithbank.com'), ('piggyvest', 'contact@piggyvest.com')) as s(slug, sender)
 where w.source_slug = s.slug and coalesce(w.alert_sender, '') = '';


-- ---------------------------------------------------------------------------
-- 2. The owner's name as these senders print it
-- ---------------------------------------------------------------------------

update jare_owner
   set own_names = own_names || array_remove(array[
         case when not ('ADEJARE ADELUGBA' = any(own_names)) then 'ADEJARE ADELUGBA' end,
         case when not ('ADELUGBA ADEJARE' = any(own_names)) then 'ADELUGBA ADEJARE' end
       ], null)
 where own_names is not null;


-- ---------------------------------------------------------------------------
-- 3. Rules for the two PiggyVest memos that name nobody
-- ---------------------------------------------------------------------------

insert into category_rules (user_id, trigger_field, trigger_value, action_category, priority)
select o.user_id, r.field, r.value, r.category, 0
  from jare_owner o
  cross join (values
    ('description', 'Monthly Interest Payment', 'Savings'),       -- PiggyVest interest, a credit
    ('description', 'Withdrawal Made',          'Transfer Out')   -- PiggyVest to the owner's bank
  ) as r(field, value, category)
 where not exists (
   select 1 from category_rules c
    where c.user_id = o.user_id and c.trigger_field = r.field
      and lower(trim(c.trigger_value)) = lower(r.value)
 );


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
declare
  n integer;
begin
  if not exists (select 1 from jare_owner) then
    raise notice 'more banks: no pinned owner yet, nothing seeded';
    return;
  end if;

  select count(distinct source_slug) into n
    from wallets
   where user_id = (select user_id from jare_owner limit 1)
     and source_slug in ('palmpay', 'zenith', 'piggyvest')
     and coalesce(alert_sender, '') <> '';
  if n <> 3 then raise exception 'expected three new wallets with senders, found %', n; end if;

  if not exists (select 1 from jare_owner where 'ADEJARE ADELUGBA' = any(own_names) and 'ADELUGBA ADEJARE' = any(own_names)) then
    raise exception 'the short name forms are not in own_names';
  end if;
  if not jare_names_own_account('ADELUGBA ADEJARE OLUWAGBENILE') then
    raise exception 'the Zenith spelling of the owner does not pass the own-name check';
  end if;

  select count(*) into n from category_rules
   where trigger_field = 'description'
     and lower(trim(trigger_value)) in ('monthly interest payment', 'withdrawal made');
  if n < 2 then raise exception 'the PiggyVest rules were not seeded'; end if;

  raise notice 'more banks verified: palmpay, zenith and piggyvest wallets exist with senders; names and rules seeded';
end
$$;
