-- ============================================================================
-- 050_diet_backfill.sql
--
-- Run after 049. Idempotent; safe to re-run: a meal already copied (by
-- meal_logs.legacy_meal_id) is skipped, so a re-run picks up only meals
-- logged on the old page since.
--
-- Diet replaces Meals (docs/diet-module.md, section 1). Every row of 042's
-- `meals` is copied into meal_logs, and its `items` JSON into meal_items,
-- so the Daily Sheet and the 7-day average include the history. The
-- `meals` table itself is left exactly as it is.
--
-- The mapping:
--   eaten_on + eaten_at (Lagos time; noon when no time was kept) -> eaten_at
--   meal_type 'snack' -> meal_slot 'snacks'; the other three unchanged
--   source 'photo' and 'text' unchanged; 'repeat' (logged again in one tap)
--     -> 'saved'; 'manual' (picked from the list) -> 'manual'
--   note -> raw_text; thumbnail carried over; status 'confirmed'
--   each item: grams and figures times its quantity, kcal capped at 3,000
--     per item as 042's jare_meal_calories did, and the original item kept
--     under estimates.legacy_042 so nothing is lost in translation
--
-- Items are copied with no food_id, so diet_item_figures (048) keeps their
-- figures as they were logged rather than re-pricing them.
-- ============================================================================

do $$
begin
  if to_regclass('public.meals') is null then
    raise notice 'diet backfill: no meals table (042 never ran); nothing to copy';
    return;
  end if;

  insert into meal_logs (user_id, client_id, eaten_at, eaten_on, meal_slot, source, status,
                         raw_text, legacy_meal_id, thumbnail, created_at)
  select m.user_id,
         'legacy-042-' || m.id,
         (m.eaten_on + coalesce(m.eaten_at, time '12:00')) at time zone 'Africa/Lagos',
         m.eaten_on,
         case when m.meal_type = 'snack' then 'snacks' else m.meal_type end,
         case m.source when 'photo' then 'photo' when 'text' then 'text' when 'repeat' then 'saved' else 'manual' end,
         'confirmed',
         nullif(left(coalesce(m.note, ''), 1000), ''),
         m.id,
         m.thumbnail,
         m.created_at
    from meals m
   where not exists (select 1 from meal_logs l where l.user_id = m.user_id and l.legacy_meal_id = m.id)
  on conflict do nothing;

  insert into meal_items (user_id, meal_id, position, name, grams, kcal, protein_g, carbs_g, fat_g, estimates)
  select l.user_id,
         l.id,
         (e.ord - 1)::integer,
         left(trim(e.i->>'name'), 80),
         round(least(5000, coalesce(n.grams, 0) * n.qty), 1),
         least(3000, greatest(0, round(coalesce(n.cal, 0) * n.qty)))::integer,
         round(least(1000, coalesce(n.protein, 0) * n.qty), 1),
         round(least(1000, coalesce(n.carbs, 0) * n.qty), 1),
         round(least(1000, coalesce(n.fat, 0) * n.qty), 1),
         jsonb_build_object('legacy_042', e.i)
    from meal_logs l
    join meals m on m.id = l.legacy_meal_id
   cross join lateral jsonb_array_elements(case when jsonb_typeof(m.items) = 'array' then m.items else '[]'::jsonb end)
                      with ordinality as e(i, ord)
   cross join lateral (
     select nullif(regexp_replace(e.i->>'grams', '[^0-9.]', '', 'g'), '')::numeric     as grams,
            nullif(regexp_replace(e.i->>'calories', '[^0-9.]', '', 'g'), '')::numeric  as cal,
            nullif(regexp_replace(e.i->>'protein_g', '[^0-9.]', '', 'g'), '')::numeric as protein,
            nullif(regexp_replace(e.i->>'carbs_g', '[^0-9.]', '', 'g'), '')::numeric   as carbs,
            nullif(regexp_replace(e.i->>'fat_g', '[^0-9.]', '', 'g'), '')::numeric     as fat,
            least(10, greatest(0.25, coalesce(nullif(regexp_replace(e.i->>'quantity', '[^0-9.]', '', 'g'), '')::numeric, 1))) as qty
   ) n
   where l.legacy_meal_id is not null
     and jsonb_typeof(e.i) = 'object'
     and length(trim(coalesce(e.i->>'name', ''))) > 0
     and not exists (select 1 from meal_items x where x.meal_id = l.id);
end
$$;


-- ---------------------------------------------------------------------------
-- Verify: every day's calories are the same in both tables
-- ---------------------------------------------------------------------------

do $$
declare
  bad record;
  copied integer;
begin
  if to_regclass('public.meals') is null then
    return;
  end if;

  select o.user_id, o.eaten_on, o.kcal as old_kcal, coalesce(n.kcal, 0) as new_kcal into bad
    from (select user_id, eaten_on, sum(jare_meal_calories(items)) as kcal from meals group by 1, 2) o
    left join (select user_id, eaten_on, sum(kcal) as kcal from meal_logs where legacy_meal_id is not null group by 1, 2) n
      on n.user_id = o.user_id and n.eaten_on = o.eaten_on
   where o.kcal <> coalesce(n.kcal, 0)
   limit 1;
  if bad is not null then
    raise exception 'diet backfill: % has % kcal in meals but % in meal_logs', bad.eaten_on, bad.old_kcal, bad.new_kcal;
  end if;

  select count(*) into copied from meal_logs where legacy_meal_id is not null;
  raise notice 'diet backfill verified: % meals copied, every day''s kcal matches', copied;
end
$$;
