-- ============================================================================
-- 045_meal_calories_empty.sql
--
-- Run after 044. Idempotent; safe to re-run.
--
-- jare_meal_calories (042) summed an empty or non-array item list to 8000,
-- not 0: Postgres's least() skips a null argument, so `least(8000, sum(...))`
-- over no rows was 8000 and the outer coalesce never saw a null. log_meal
-- re-sums every meal with it, so a meal saved with no recognisable item
-- would have logged a whole day's calories. Found by the migration harness
-- (scripts/db-test.mjs): 042's own verify block asserts 0 and raised, which
-- also means 042 could not be applied whole on a fresh project. The same
-- fix is in 042 for fresh projects; this file carries it to a live one.
-- ============================================================================

create or replace function jare_meal_calories(p_items jsonb) returns integer
language sql
immutable
as $$
  select least(8000, coalesce(sum(
    least(3000, greatest(0, round(
      coalesce(nullif(regexp_replace(i->>'calories', '[^0-9.\-]', '', 'g'), '')::numeric, 0)
      * least(10, greatest(0.25, coalesce(nullif(regexp_replace(i->>'quantity', '[^0-9.]', '', 'g'), '')::numeric, 1)))
    )))
  ), 0))::integer
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as i
  where jsonb_typeof(i) = 'object';
$$;

revoke execute on function jare_meal_calories(jsonb) from public, anon;
grant  execute on function jare_meal_calories(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
begin
  if jare_meal_calories('[]'::jsonb) <> 0 or jare_meal_calories('"nope"'::jsonb) <> 0 or jare_meal_calories(null) <> 0 then
    raise exception 'jare_meal_calories: empty or non-array input should be 0';
  end if;
  if jare_meal_calories('[{"name":"Akara","calories":80,"quantity":3},{"name":"Coke","calories":"210"},{"calories":999},{"name":"Nkwobi","calories":99999}]'::jsonb) <> 4449 then
    raise exception 'jare_meal_calories: expected 4449';
  end if;
  raise notice 'jare_meal_calories: an empty meal is 0 kcal, caps held';
end
$$;
