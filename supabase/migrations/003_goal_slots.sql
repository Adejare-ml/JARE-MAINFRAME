-- ============================================================================
-- 003_goal_slots.sql
--
-- Run after 002. Idempotent; safe to re-run.
--
-- Daily HQ saved the day's three priorities by DELETING every goal for that
-- date and re-inserting. A dropped connection between the two erased the day
-- while the screen still showed the text, and every save reset `completed` to
-- false, so a checkbox could never survive an edit.
--
-- A stable slot per priority makes the save an upsert instead.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Slot column
-- ---------------------------------------------------------------------------

alter table goals add column if not exists slot smallint;
alter table goals add column if not exists completed boolean default false;


-- ---------------------------------------------------------------------------
-- 2. Backfill, matching how the app already reads them
--
-- Daily HQ takes the first three rows ordered by created_at, so numbering by
-- that same order keeps every existing priority in the position it is
-- currently displayed in.
-- ---------------------------------------------------------------------------

with numbered as (
  select id,
         row_number() over (
           partition by period, target_date
           order by created_at asc, id asc
         ) - 1 as computed_slot
    from goals
   where slot is null
)
update goals g
   set slot = n.computed_slot
  from numbered n
 where g.id = n.id;


-- ---------------------------------------------------------------------------
-- 3. Check before constraining
--
-- The unique index cannot build if a day already holds more rows than the UI
-- can address. PREVIEW: expect zero rows. Anything here needs a decision --
-- most likely deleting the extras, since the app has only ever shown three.
-- ---------------------------------------------------------------------------

select period, target_date, count(*) as goals_on_that_day
  from goals
 group by period, target_date
having count(*) > 3
 order by count(*) desc;


-- ---------------------------------------------------------------------------
-- 4. One goal per slot per day
-- ---------------------------------------------------------------------------

create unique index if not exists goals_period_date_slot_uniq
    on goals (period, target_date, slot);


-- ---------------------------------------------------------------------------
-- 5. Verify
-- ---------------------------------------------------------------------------

-- Expect zero rows: every goal should now carry a slot.
select count(*) as goals_missing_slot from goals where slot is null;
