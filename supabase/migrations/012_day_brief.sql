-- ============================================================================
-- 012_day_brief.sql
--
-- Run after 011. Idempotent; safe to re-run.
--
-- What the day already has in it before you decide what to put in it.
--
-- Every task this app has produced so far assumes the day is empty. The
-- decomposition divides a monthly target by the days remaining and asks for a
-- share of each one, which is right arithmetically and silently wrong on a
-- Tuesday with six hours of meetings. The plan then reads as a personal failure
-- rather than as a plan made without looking at the calendar.
--
-- So an overnight run reads tomorrow's calendar and writes down what is already
-- fixed, and the morning starts from a correction rather than a blank page.
--
-- Two things this table deliberately is not.
--
--   It is not a copy of your calendar. It holds the day's shape -- what is
--   booked, and how much is left -- for one day at a time, refreshed each
--   night. Anything richer would be a second calendar to keep in sync with the
--   first, and a stale copy of a calendar is worse than no copy.
--
--   It is not a task list. Nothing here is something to tick off. A meeting is
--   context, and putting meetings in `goals` would inflate every completion
--   figure the app reports with events you were never going to "finish".
-- ============================================================================

create table if not exists day_briefs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid default auth.uid(),

  -- The day this describes, in local time. Unique, because the overnight run
  -- re-drafts rather than accumulates: without this a week of runs leaves seven
  -- rows for Tuesday and the app has to guess which is current.
  brief_date   date not null,

  -- The fixed commitments, shaped like
  --   [{"title": "...", "start": "...", "end": "...", "allDay": false}]
  -- Titles included because "3 hours booked" is a number and "3 hours booked,
  -- two of them the client review" is a reason.
  events       jsonb not null default '[]'::jsonb,

  -- Minutes inside the working window that are spoken for, and what is left.
  -- Stored rather than derived for the same reason `evidence` is: the browser
  -- cannot reach the calendar, so it cannot recompute these.
  --
  -- Overlapping meetings are merged before counting. Two calls that overlap by
  -- half an hour cost ninety minutes, not two hours, and a figure that
  -- double-counts them would report a day as fuller than it is.
  busy_minutes integer not null default 0,
  free_minutes integer not null default 0,

  -- 'calendar' when it came from Google, 'empty' when the run found nothing,
  -- 'unavailable' when the token could not read the calendar at all.
  --
  -- The third is the one that earns this column. Without it, a day with no
  -- meetings and a day the app could not see are both stored as zero events --
  -- and "you are free all day" is a very different thing to say than "I could
  -- not look". This project has made that mistake before, with a sync that
  -- reported an empty inbox when every insert was bouncing.
  source       text not null default 'calendar',

  drafted_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- Heal a table that predates this file, in the shape of 004, 008 and 011.
alter table day_briefs add column if not exists user_id      uuid default auth.uid();
alter table day_briefs add column if not exists brief_date   date;
alter table day_briefs add column if not exists events       jsonb not null default '[]'::jsonb;
alter table day_briefs add column if not exists busy_minutes integer not null default 0;
alter table day_briefs add column if not exists free_minutes integer not null default 0;
alter table day_briefs add column if not exists source       text not null default 'calendar';
alter table day_briefs add column if not exists drafted_at   timestamptz not null default now();
alter table day_briefs add column if not exists created_at   timestamptz not null default now();

alter table day_briefs drop constraint if exists day_briefs_source_valid;
alter table day_briefs add  constraint day_briefs_source_valid
  check (source in ('calendar', 'empty', 'unavailable'));

-- Collapse duplicates before the unique index is attempted. This is the lesson
-- of 004, which died on exactly this statement shape and blocked every
-- migration after it.
--
-- Safe to collapse here in the way it was not for goals: a brief is a
-- regenerated snapshot of a day, not something a person wrote, so the most
-- recently drafted one is simply the current answer.
delete from day_briefs a
 using day_briefs b
 where a.brief_date is not null
   and a.brief_date = b.brief_date
   and (a.drafted_at, a.id) < (b.drafted_at, b.id);

-- The overnight run targets this by name via onConflict. A plain index would
-- not do: PostgREST needs a unique constraint or index to arbitrate, and
-- without one every upsert fails with 42P10 rather than updating.
create unique index if not exists day_briefs_date_uniq on day_briefs (brief_date);

do $$
begin
  if exists (select 1 from day_briefs where brief_date is null) then
    raise warning 'day_briefs has rows with a null brief_date, so the column stays nullable. Delete them and re-run this migration.';
  else
    alter table day_briefs alter column brief_date set not null;
  end if;
end
$$;

alter table day_briefs enable row level security;

-- Matches the policy shape used by every other table in this project today.
-- Tighten alongside the others when multi-tenancy lands.
drop policy if exists day_briefs_all_authenticated on day_briefs;
create policy day_briefs_all_authenticated on day_briefs
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Verify
--
-- Raising, in the style of 008 through 011.
-- ---------------------------------------------------------------------------

do $$
declare
  stored_free  integer;
  stored_count integer;
begin
  -- The upsert must REPLACE the day, not add a second copy of it.
  insert into day_briefs (brief_date, events, busy_minutes, free_minutes, source)
  values (date '1990-04-01', '[{"title": "stale"}]'::jsonb, 60, 420, 'calendar');

  insert into day_briefs (brief_date, events, busy_minutes, free_minutes, source)
  values (date '1990-04-01', '[{"title": "fresh"}]'::jsonb, 120, 360, 'calendar')
  on conflict (brief_date) do update
    set events = excluded.events,
        busy_minutes = excluded.busy_minutes,
        free_minutes = excluded.free_minutes,
        drafted_at = now();

  select count(*), max(free_minutes) into stored_count, stored_free
    from day_briefs where brief_date = date '1990-04-01';

  if stored_count <> 1 then
    raise exception 'day_briefs upsert made % rows for one day; the unique index is not arbitrating', stored_count;
  end if;
  if stored_free <> 360 then
    raise exception 'day_briefs upsert did not replace the day it re-drafted';
  end if;

  -- "I could not look" must be storable, and must not be confusable with
  -- "there was nothing there".
  insert into day_briefs (brief_date, source, busy_minutes, free_minutes)
  values (date '1990-04-02', 'unavailable', 0, 0);

  begin
    insert into day_briefs (brief_date, source)
    values (date '1990-04-03', 'probably fine');
    raise exception 'day_briefs_source_valid accepted a source that does not exist';
  exception when check_violation then
    null;
  end;

  delete from day_briefs where brief_date between date '1990-04-01' and date '1990-04-03';

  raise notice 'day_briefs verified: one row per day, re-drafting replaces it, unreadable is distinguishable from empty';
end
$$;

select 'day_briefs' as table_name,
       count(*)                                        as days,
       count(*) filter (where source = 'unavailable')  as unreadable
  from day_briefs;
