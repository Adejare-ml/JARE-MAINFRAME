-- ============================================================================
-- 053_diet_coach.sql
--
-- Run after 052. Idempotent; safe to re-run.
--
-- The Diet module, Phase 4: the coach (docs/diet-module.md, prompts/coach.md).
--
-- meal_logs.coach: what the coach (claude-haiku-5-5, the diet-coach edge
-- function) said about a meal logged from a note, a voice note or a photo:
--   {"verdict": "fits", "reason": "...", "flag": null, "agreed": true,
--    "model": "claude-haiku-5-5", "at": "2026-11-10T12:31:04Z"}
-- verdict and reason on the meal itself are the ones shown. They are the
-- coach's when it agrees with the rule-based verdict (src/lib/diet/verdict.js),
-- and the rule's when it does not; `agreed` records which, so a later look
-- can say how often the coach and the rules part ways. Saved and hand-picked
-- meals never call the coach and leave this null.
--
-- The 14-day target review needs no new column: diet_settings already has
-- target_reviewed_at and pending_target (048).
-- ============================================================================

alter table meal_logs add column if not exists coach jsonb;

alter table meal_logs drop constraint if exists meal_logs_coach_object;
alter table meal_logs add  constraint meal_logs_coach_object check (coach is null or jsonb_typeof(coach) = 'object');

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'meal_logs' and column_name = 'coach') then
    raise exception 'meal_logs.coach is missing';
  end if;
  raise notice 'diet coach verified: meal_logs.coach in place';
end
$$;
