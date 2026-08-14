-- ============================================================================
-- 010_repo_goals.sql
--
-- Run after 009. Idempotent; safe to re-run.
--
-- Goals that are about code rather than money.
--
-- 009 gave goals a cadence and let the measurable ones read the ledger for
-- themselves. That works because the browser already holds the transactions: a
-- 'save_at_least' goal counts credits in rows it has in memory, and nothing
-- needs to be stored for it -- the answer is recomputed on every render, and
-- voiding a transaction moves it back the same day.
--
-- A goal about commits cannot work that way. The browser has no GitHub
-- credentials and should never have any, so it cannot ask whether the code
-- landed. The check runs where the credentials already are -- a scheduled
-- Action, beside the Gmail sync -- and the answer has to be written down for
-- the browser to read.
--
-- That is a real departure from the rule this schema otherwise follows, which
-- is to derive anything the data can answer and store only human decisions. It
-- is deliberate, and it is the reason `evidence` is a jsonb of commits rather
-- than a boolean: the app is asserting something it cannot recompute, so it has
-- to be able to show its working. `goalProgress` returns `source` and
-- transactions record `direction_source` for the same reason.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Where the verifier writes its answer
-- ---------------------------------------------------------------------------

-- When the check last ran. NULL is load-bearing: it means "nobody has looked",
-- which is a different state from "looked and found nothing". Collapsing the
-- two would report every unchecked day as a missed one -- the same mistake as a
-- green sync run that imported nothing being read as an empty inbox.
alter table goals add column if not exists verified_at timestamptz;

-- What the verifier found: the repository, the window it asked about, and the
-- commits themselves. Shaped like
--   {"repo": "...", "from": "...", "to": "...", "counted": 3,
--    "commits": [{"sha": "...", "message": "...", "at": "..."}]}
-- A count alone would be unauditable, and a boolean would be worse -- there
-- would be no way to tell a day of real work from a day the verifier got wrong.
alter table goals add column if not exists evidence jsonb;

-- Why the planned work did not land, in the user's own words. Office work
-- overran, a meeting ate the afternoon, the approach turned out to be wrong.
-- A bare miss teaches nothing; a miss with a reason is the only part of this
-- worth reading back at the end of a month.
alter table goals add column if not exists blocked_reason text;


-- ---------------------------------------------------------------------------
-- 2. Let a repo goal exist at all
--
-- Both of these constraints currently refuse one. Widening the metric list
-- without amending the second is the trap: every repo goal would then be
-- accepted by name and rejected by SQLSTATE 23514 on insert, which surfaces in
-- the app as a constraint name and no explanation.
-- ---------------------------------------------------------------------------

alter table goals drop constraint if exists goals_metric_valid;
alter table goals add  constraint goals_metric_valid
  check (metric in ('manual', 'save_at_least', 'spend_under', 'repo_commits'));

-- Restated rather than patched. Every measured goal still needs a number to
-- measure against -- that part was always right, and a 'save_at_least' goal
-- with no target still reads as complete on creation without it. What changes
-- is the second half: a money goal is measured by a category or a wallet, and
-- a repo goal is measured by the repository, which is configuration rather than
-- a column. So it satisfies the requirement by being what it is.
alter table goals drop constraint if exists goals_metric_needs_target;
alter table goals add  constraint goals_metric_needs_target check (
  metric = 'manual'
  or (
    target_amount is not null
    and target_amount > 0
    and (
      metric = 'repo_commits'
      or metric_category is not null
      or metric_wallet_id is not null
    )
  )
);


-- ---------------------------------------------------------------------------
-- 3. The verifier's own query
--
-- It asks for repo goals in a recent date range and nothing else. Partial, so
-- it stays the size of the repo goals rather than the size of the table -- on a
-- ledger where nearly every row is a daily money task, a full index on
-- (metric, target_date) would be almost entirely rows this query never wants.
-- ---------------------------------------------------------------------------

create index if not exists goals_repo_metric_idx
    on goals (target_date)
 where metric = 'repo_commits';


-- ---------------------------------------------------------------------------
-- 4. Verify
--
-- Raising, in the style of 008 and 009. The third case below is the one that
-- matters most: the easy way to make repo goals insertable is to drop the
-- category-or-wallet requirement outright, which would also let a savings goal
-- through with nothing measuring it. That regression would be invisible until
-- a goal silently sat at 0 forever.
-- ---------------------------------------------------------------------------

do $$
declare
  stored jsonb;
begin
  -- A repo goal with a target and neither category nor wallet must be accepted.
  insert into goals (title, period, target_date, slot, metric, target_amount)
  values ('__check_010__ repo', 'monthly', date '1990-02-01', 0, 'repo_commits', 40);

  -- A repo goal with no target must still be refused.
  begin
    insert into goals (title, period, target_date, slot, metric)
    values ('__check_010__ untargeted', 'monthly', date '1990-02-02', 0, 'repo_commits');
    raise exception 'a repo goal with no target was accepted; goals_metric_needs_target is too weak';
  exception when check_violation then
    null;
  end;

  -- A money goal with no category and no wallet must STILL be refused.
  begin
    insert into goals (title, period, target_date, slot, metric, target_amount)
    values ('__check_010__ unmeasured money', 'monthly', date '1990-02-03', 0, 'save_at_least', 1000);
    raise exception 'a savings goal with nothing measuring it was accepted; the amendment widened too far';
  exception when check_violation then
    null;
  end;

  -- An unknown metric must still be refused.
  begin
    insert into goals (title, period, target_date, slot, metric, target_amount)
    values ('__check_010__ nonsense', 'monthly', date '1990-02-04', 0, 'vibes', 1);
    raise exception 'goals_metric_valid accepted a metric that does not exist';
  exception when check_violation then
    null;
  end;

  -- Evidence must survive the round trip as structured json, not as text.
  update goals
     set verified_at = now(),
         evidence = jsonb_build_object(
           'repo', 'owner/name',
           'counted', 2,
           'commits', jsonb_build_array(
             jsonb_build_object('sha', 'abc123', 'message', 'first'),
             jsonb_build_object('sha', 'def456', 'message', 'second')
           )
         )
   where title = '__check_010__ repo';

  select evidence into stored from goals where title = '__check_010__ repo';

  if jsonb_array_length(stored -> 'commits') <> 2 then
    raise exception 'evidence did not round-trip as jsonb';
  end if;

  if (stored ->> 'repo') is distinct from 'owner/name' then
    raise exception 'evidence lost its repo on the way to storage';
  end if;

  delete from goals where title like '__check_010__%';

  raise notice 'repo goals verified: insertable without a category, evidence stores as jsonb, money goals still need a measure';
end
$$;

select 'goals' as table_name,
       count(*) filter (where metric = 'repo_commits') as repo_goals,
       count(*) filter (where verified_at is not null) as verified
  from goals;
