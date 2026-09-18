-- ============================================================================
-- 023_week_recaps.sql
--
-- Run after 022. Idempotent; safe to re-run.
--
-- Where the weekly recap lives: one row per week, replaced (not accumulated)
-- each time scripts/weekly-recap.mjs runs, mirroring 012_day_brief.sql's
-- upsert-replaces-the-day shape for the same reason -- a recap is a
-- regenerated summary of a week, not something a person wrote, so the most
-- recently drafted one is simply the current answer.
--
-- `sentences` holds exactly what src/lib/recapReview.js accepted:
--   [{"sentence": "...", "cites": "spent"}, ...]
-- Never anything reviewPlan-style rejected. The review step already ran by
-- the time this table is written to -- this is not a second gate, it is
-- storage for what passed the first one.
-- ============================================================================

create table if not exists week_recaps (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid default auth.uid(),

  -- The Monday this recap is about. Unique for the same reason day_briefs'
  -- brief_date is: without it a week of retries leaves several rows for the
  -- same week and the app has to guess which is current.
  week_start  date not null,

  -- [{"sentence": "...", "cites": "spent"}, ...] -- only what reviewRecap kept.
  sentences   jsonb not null default '[]'::jsonb,

  -- Which provider answered ('ollama' | 'nvidia'), so a wrong sentence that
  -- somehow slipped past review is at least traceable to where it came from.
  model       text,

  drafted_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- Heal a table that predates this file, in the shape of 004, 008, 011 and 012.
alter table week_recaps add column if not exists user_id    uuid default auth.uid();
alter table week_recaps add column if not exists week_start date;
alter table week_recaps add column if not exists sentences  jsonb not null default '[]'::jsonb;
alter table week_recaps add column if not exists model      text;
alter table week_recaps add column if not exists drafted_at timestamptz not null default now();
alter table week_recaps add column if not exists created_at timestamptz not null default now();

-- Collapse duplicates before the unique index is attempted -- the lesson of
-- 004, which died on exactly this statement shape and blocked every
-- migration after it. Safe here the same way it was safe for day_briefs: the
-- most recently drafted row for a week is simply the current answer.
delete from week_recaps a
 using week_recaps b
 where a.week_start is not null
   and a.week_start = b.week_start
   and (a.drafted_at, a.id) < (b.drafted_at, b.id);

-- Targeted by name via onConflict in the weekly-recap script. A plain index
-- would not do: PostgREST needs a unique constraint or index to arbitrate,
-- and without one every upsert fails with 42P10 rather than replacing the week.
create unique index if not exists week_recaps_week_start_uniq on week_recaps (week_start);

do $$
begin
  if exists (select 1 from week_recaps where week_start is null) then
    raise warning 'week_recaps has rows with a null week_start, so the column stays nullable. Delete them and re-run this migration.';
  else
    alter table week_recaps alter column week_start set not null;
  end if;
end
$$;

alter table week_recaps enable row level security;

-- Matches the policy shape used by every other table in this project today.
-- Tighten alongside the others when multi-tenancy lands.
drop policy if exists week_recaps_all_authenticated on week_recaps;
create policy week_recaps_all_authenticated on week_recaps
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Verify
--
-- Raising, in the style of 008 through 012.
-- ---------------------------------------------------------------------------

do $$
declare
  stored_count     integer;
  stored_sentences jsonb;
begin
  -- The upsert must REPLACE the week, not add a second copy of it.
  insert into week_recaps (week_start, sentences, model)
  values (date '1990-04-02', '[{"sentence": "stale", "cites": "spent"}]'::jsonb, 'ollama');

  insert into week_recaps (week_start, sentences, model)
  values (date '1990-04-02', '[{"sentence": "fresh", "cites": "spent"}]'::jsonb, 'nvidia')
  on conflict (week_start) do update
    set sentences = excluded.sentences,
        model = excluded.model,
        drafted_at = now();

  select count(*) into stored_count from week_recaps where week_start = date '1990-04-02';
  if stored_count <> 1 then
    raise exception 'week_recaps upsert made % rows for one week; the unique index is not arbitrating', stored_count;
  end if;

  select sentences into stored_sentences from week_recaps where week_start = date '1990-04-02';
  if stored_sentences->0->>'sentence' <> 'fresh' then
    raise exception 'week_recaps upsert did not replace the week it re-drafted';
  end if;

  delete from week_recaps where week_start = date '1990-04-02';

  raise notice 'week_recaps verified: one row per week, re-drafting replaces it';
end
$$;

select 'week_recaps' as table_name, count(*) as weeks from week_recaps;
