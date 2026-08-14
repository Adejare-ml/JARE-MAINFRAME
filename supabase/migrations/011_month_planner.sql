-- ============================================================================
-- 011_month_planner.sql
--
-- Run after 010. Idempotent; safe to re-run.
--
-- Somewhere for a model to put a suggestion without it becoming a fact.
--
-- Everything the app has written to `goals` so far has been arithmetic. 009's
-- decomposition divides a target by the periods left; 010's verifier counts
-- commits. Both are checkable by hand, both give the same answer twice, and
-- neither can be wrong in an interesting way -- if the sum is wrong you can see
-- that it is wrong.
--
-- A model deciding what to work on this week is none of those things. It can be
-- confidently, fluently wrong, and this project has shipped exactly that twice:
-- `enable_thinking` sent to a model that had been retired, and a `MEDIUM`
-- confidence the database had always rejected. Both looked fine in the code and
-- failed silently in production for weeks.
--
-- So two rules are built into the shape here rather than into the code that
-- writes it.
--
--   A proposal is not a plan. `plan_status` starts at 'draft' for anything a
--   model wrote, and a draft is invisible to every screen except the one that
--   asks you to approve it. Nothing derives from a draft, nothing counts it,
--   and a planner that runs while you are asleep cannot change what you see in
--   the morning.
--
--   A suggestion has to cite something. `plan_evidence` records what the model
--   claimed to be reasoning from -- a real path in the repository, or a gap you
--   logged yourself. src/lib/planReview.js refuses anything that cites nothing,
--   and this column is where the citation is kept so the refusal can be audited
--   later rather than only at the moment it happened.
--
-- The arithmetic keeps its job. `focus` is the words; `target_amount` is still
-- the number, still recomputed every run, and a model never touches it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Words the arithmetic does not own
-- ---------------------------------------------------------------------------

-- What this period is actually about. "10 commits toward Ship the planner" is
-- a quantity; "Cover src/lib/constants.js, which has no test file" is a plan.
-- Written only by the planner, and deliberately NOT part of `title` -- the
-- generator rewrites titles every run to keep the number current, and a model's
-- sentence living there would be silently overwritten by arithmetic within a
-- day.
alter table goals add column if not exists focus text;

-- 'active' | 'draft' | 'discarded'.
--
-- Defaulting to 'active' is what makes this migration safe to run on a live
-- table: every goal that already exists keeps behaving exactly as it did. Only
-- rows the planner writes start life as drafts.
alter table goals add column if not exists plan_status text not null default 'active';

-- What the model said it was reasoning from, kept so the claim can be checked
-- after the fact. Shaped like
--   {"cites": "src/lib/constants.js", "kind": "path", "model": "...",
--    "reason": "..."}
alter table goals add column if not exists plan_evidence jsonb;

alter table goals add column if not exists planned_at timestamptz;

alter table goals drop constraint if exists goals_plan_status_valid;
alter table goals add  constraint goals_plan_status_valid
  check (plan_status in ('active', 'draft', 'discarded'));

-- "What is waiting for me to approve it" is the only question drafts are asked,
-- and it is asked against a table where they are a small minority.
create index if not exists goals_draft_idx
    on goals (target_date)
 where plan_status = 'draft';


-- ---------------------------------------------------------------------------
-- 2. Things you did not understand
--
-- The planner's other grounded input. A recommendation derived from "what
-- people at this stage usually do" is a guess wearing a suit; one derived from
-- "you leaned on an agent for PostgREST upsert semantics on the 12th and could
-- not have written it yourself" is about you, and can be checked by the person
-- it is about.
-- ---------------------------------------------------------------------------

create table if not exists knowledge_gaps (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid default auth.uid(),

  -- Short and reusable: "PostgREST upsert semantics", not a paragraph. Unique,
  -- so hitting the same wall twice deepens one record rather than scattering
  -- five near-identical ones the planner would then treat as five gaps.
  topic       text not null,

  -- What actually happened, in your words.
  note        text,

  -- Where it came from -- 'agent' when you took code you could not have
  -- written, 'manual' when you noticed it yourself.
  source      text not null default 'manual',

  -- Set when you no longer need it. Kept rather than deleted: a gap you closed
  -- is the most useful thing in this table, and deleting it loses the only
  -- record that you did.
  resolved_at timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Heal a table that predates this file, in the shape of 004 and 008: `create
-- table if not exists` skips silently when something by that name is there, and
-- would then fail on the first statement naming a column it never had.
alter table knowledge_gaps add column if not exists user_id     uuid default auth.uid();
alter table knowledge_gaps add column if not exists topic       text;
alter table knowledge_gaps add column if not exists note        text;
alter table knowledge_gaps add column if not exists source      text not null default 'manual';
alter table knowledge_gaps add column if not exists resolved_at timestamptz;
alter table knowledge_gaps add column if not exists created_at  timestamptz not null default now();
alter table knowledge_gaps add column if not exists updated_at  timestamptz not null default now();

-- Collapse duplicates before the unique index is attempted. 004 died on exactly
-- this statement shape against a table already holding duplicates, and because
-- the runner applies this directory in order, that one error blocked every
-- migration after it.
--
-- Safe to collapse here in the way it was not for goals: the topic -- the only
-- part the planner reads -- is identical across duplicates by definition, so
-- what is lost is at most one alternative wording of the same note.
--
-- The ordering is a best effort rather than a guarantee. On a table that
-- predates this file, `updated_at` was created by the ALTER above and every row
-- carries the same `now()`, so the tiebreak falls to `id` and which note
-- survives is arbitrary. That is the honest limit of healing a shape nobody
-- recorded -- it is stated here rather than implied by a confident comment.
delete from knowledge_gaps a
 using knowledge_gaps b
 where a.topic is not null
   and a.topic = b.topic
   and (a.updated_at, a.id) < (b.updated_at, b.id);

-- A plain unique index on the column itself, not on lower(topic): PostgREST's
-- `onConflict` names columns, and cannot target an expression index. Normalising
-- case is the app's job on the way in.
create unique index if not exists knowledge_gaps_topic_uniq
    on knowledge_gaps (topic);

do $$
begin
  if exists (select 1 from knowledge_gaps where topic is null) then
    raise warning 'knowledge_gaps has rows with a null topic, so the column stays nullable. Delete them and re-run this migration.';
  else
    alter table knowledge_gaps alter column topic set not null;
  end if;
end
$$;

-- "What is still open" is the question the planner asks every run.
create index if not exists knowledge_gaps_open_idx
    on knowledge_gaps (created_at desc) where resolved_at is null;

alter table knowledge_gaps enable row level security;

-- Matches the policy shape used by every other table in this project today.
-- Tighten alongside the others when multi-tenancy lands.
drop policy if exists knowledge_gaps_all_authenticated on knowledge_gaps;
create policy knowledge_gaps_all_authenticated on knowledge_gaps
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 3. Verify
--
-- Raising, in the style of 008, 009 and 010.
--
-- The first case is the one that matters most. If `plan_status` did not default
-- to 'active', every goal already in this table would become invisible the
-- moment the app started filtering drafts out -- a migration that empties your
-- screens while reporting success.
-- ---------------------------------------------------------------------------

do $$
declare
  existing_status text;
  gap_note        text;
begin
  -- An ordinary goal, written the way the app writes one, must come out active.
  insert into goals (title, period, target_date, slot)
  values ('__check_011__ ordinary', 'daily', date '1990-03-01', 0);

  select plan_status into existing_status
    from goals where title = '__check_011__ ordinary';

  if existing_status is distinct from 'active' then
    raise exception 'plan_status defaulted to %, so every existing goal would be treated as a draft', existing_status;
  end if;

  -- A draft must be storable, with its citation.
  insert into goals (title, period, target_date, slot, plan_status, focus, plan_evidence, planned_at)
  values ('__check_011__ draft', 'weekly', date '1990-03-05', 10, 'draft',
          'Cover src/lib/constants.js, which has no test file',
          '{"cites": "src/lib/constants.js", "kind": "path"}'::jsonb, now());

  if (select plan_evidence ->> 'cites' from goals where title = '__check_011__ draft')
     is distinct from 'src/lib/constants.js' then
    raise exception 'plan_evidence did not round-trip as jsonb';
  end if;

  -- Anything else must be refused, or "draft" stops meaning anything.
  begin
    insert into goals (title, period, target_date, slot, plan_status)
    values ('__check_011__ nonsense', 'daily', date '1990-03-02', 0, 'proposed');
    raise exception 'goals_plan_status_valid accepted a status that does not exist';
  exception when check_violation then
    null;
  end;

  -- Logging the same gap twice must deepen one record, not make two -- the
  -- planner counts open gaps, and five copies of one wall would read as five.
  insert into knowledge_gaps (topic, note, source)
  values ('__check_011__ topic', 'first time', 'agent');

  insert into knowledge_gaps (topic, note, source)
  values ('__check_011__ topic', 'hit it again', 'agent')
  on conflict (topic) do update set note = excluded.note, updated_at = now();

  select note into gap_note from knowledge_gaps where topic = '__check_011__ topic';

  if gap_note <> 'hit it again' then
    raise exception 'knowledge_gaps upsert on topic did not update; the unique index is not arbitrating';
  end if;

  if (select count(*) from knowledge_gaps where topic = '__check_011__ topic') <> 1 then
    raise exception 'knowledge_gaps upsert on topic inserted a duplicate';
  end if;

  delete from knowledge_gaps where topic like '__check_011__%';
  delete from goals where title like '__check_011__%';

  raise notice 'planner verified: goals default to active, drafts store their citation, one gap stays one row';
end
$$;

select 'goals' as table_name,
       count(*) filter (where plan_status = 'draft')  as drafts,
       count(*) filter (where plan_status = 'active') as active,
       count(*) filter (where focus is not null)      as with_focus
  from goals
union all
select 'knowledge_gaps',
       count(*) filter (where resolved_at is null),
       count(*) filter (where resolved_at is not null),
       0
  from knowledge_gaps;
