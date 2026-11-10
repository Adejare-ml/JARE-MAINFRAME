-- ============================================================================
-- 049_diet_seed.sql
--
-- Run after 048. Idempotent; safe to re-run (every insert skips rows that
-- are already there, by name).
--
-- Starting data for the Diet module (docs/diet-module.md):
--
--   * about 60 foods common in Nigerian home cooking and street food,
--     per 100 g as eaten (cooked weight for cooked dishes);
--   * the "Beans pot" recipe: 1,000 g dry brown beans, 54 g palm oil,
--     150 g carrots, 300 g blended tomato and pepper, 5 portions;
--   * two saved meals for one-tap logging: "Beans container" and
--     "3 boiled eggs + 1 plantain";
--   * a diet_settings row, carrying over the calorie target the Meals
--     page used (user_settings.calorie_target) if there is one. Nothing
--     else in it: measurements and food rules are entered on the Diet
--     settings screen, never committed (the repo is public).
--
-- On the food figures, plainly: the build spec asks for figures from the
-- FAO/INFOODS West African Food Composition Table (WAFCT 2019), with every
-- estimated row marked. The machine this was written on could not reach
-- fao.org (blocked by its network policy), so no row was checked against
-- the table. Every row below is therefore marked estimated = true, and its
-- source says what it is: a typical published value for the food as
-- served, from general composition data, with home recipes (oil in the
-- stew, the egg in the moi moi) assumed at a typical amount. They are good
-- enough to log against and should be corrected row by row against WAFCT
-- 2019 when it is to hand; correcting a food changes future logs only, as
-- meal_items keep the figures they were logged with.
--
-- The rows belong to the owner: auth.uid() when run as the signed-in
-- owner, else jare_sole_owner() (035) when run from the SQL editor.
-- ============================================================================

do $$
declare
  v_owner  uuid;
  v_recipe uuid;
  v_target text;
begin
  v_owner := auth.uid();
  if v_owner is null then
    begin
      v_owner := jare_sole_owner();
    exception when others then
      raise notice 'diet seed skipped: %. Sign in to the app once, then run 049 again.', sqlerrm;
      return;
    end;
  end if;

  -- -------------------------------------------------------------------------
  -- Foods
  -- -------------------------------------------------------------------------
  insert into foods (user_id, name, aliases, kcal_per_100g, protein_g, carbs_g, fat_g,
                     typical_portion_g, portion_label, source, estimated)
  select v_owner, f.name, f.aliases, f.kcal, f.protein, f.carbs, f.fat, f.portion_g, f.portion_label,
         'Estimate: typical published value for the food as served; not yet checked against WAFCT 2019. ' || f.note,
         true
    from (values
      -- Rice, swallow and other staples
      ('White rice, boiled', array['rice', 'white rice', 'boiled rice'], 130, 2.7, 28.2, 0.3, 250, '2 serving spoons', 'Cooked, unsalted.'),
      ('Jollof rice', array['jollof', 'party jollof'], 165, 3.0, 27.0, 5.0, 300, '1 takeaway pack', 'Includes typical cooking oil.'),
      ('Fried rice', array['nigerian fried rice'], 175, 3.5, 26.0, 6.5, 300, '1 takeaway pack', 'Includes typical cooking oil and vegetables.'),
      ('Eba', array['garri swallow', 'eba swallow'], 160, 0.6, 38.5, 0.3, 250, '1 wrap (fist-sized)', 'Garri made up with hot water.'),
      ('Garri, dry', array['garri', 'gari', 'soaked garri'], 360, 1.2, 86.0, 0.5, 100, 'about 1 cup', 'Dry granules, as soaked or drunk.'),
      ('Amala', array['amala swallow', 'yam flour swallow'], 115, 1.5, 26.0, 0.2, 300, '1 wrap', 'Yam flour made up with water.'),
      ('Pounded yam', array['iyan', 'poundo', 'poundo yam'], 120, 1.5, 28.0, 0.2, 300, '1 wrap', 'Fresh yam or flour, made up.'),
      ('Semovita swallow', array['semo', 'semovita'], 140, 4.5, 29.0, 0.4, 250, '1 wrap', 'Made up with water.'),
      ('Fufu', array['akpu', 'cassava fufu'], 150, 0.5, 36.0, 0.3, 250, '1 wrap', 'Fermented cassava.'),
      ('Yam, boiled', array['boiled yam', 'yam'], 116, 1.5, 27.5, 0.1, 200, '2 slices', 'Boiled, no oil.'),
      ('Yam, fried', array['dundun', 'fried yam'], 230, 2.0, 33.0, 10.0, 150, '5 chips', 'Deep fried.'),
      ('Plantain, boiled', array['boiled plantain', 'plantain'], 116, 0.8, 31.0, 0.2, 180, '1 medium finger', 'Ripe or unripe, boiled.'),
      ('Fried plantain', array['dodo', 'fried plantains'], 260, 1.5, 40.0, 11.0, 150, '10 slices', 'Ripe, deep fried.'),
      ('Roasted plantain', array['bole', 'boli'], 135, 1.3, 35.0, 0.4, 200, '1 finger', 'Roasted, no oil.'),
      ('Indomie, cooked', array['indomie', 'noodles', 'instant noodles'], 157, 3.3, 21.0, 6.7, 210, '1 pack (70 g dry)', 'Cooked with its seasoning and oil sachets; the pack states its own figures.'),
      ('Agege bread', array['bread', 'agege', 'white bread'], 290, 8.5, 54.0, 4.0, 60, '1 thick slice', 'Nigerian sweet white bread.'),
      ('Pap', array['ogi', 'akamu', 'koko'], 50, 0.5, 11.0, 0.3, 300, '1 bowl', 'Made up with water, no sugar or milk (log those separately).'),
      ('Spaghetti, cooked', array['spaghetti', 'pasta'], 158, 5.8, 31.0, 0.9, 250, '1 plate', 'Boiled, no sauce.'),
      ('Boiled corn', array['corn', 'maize', 'agbado'], 96, 3.4, 21.0, 1.5, 150, '1 cob (kernels)', 'Boiled or roasted.'),
      -- Beans
      ('Beans porridge', array['beans', 'ewa', 'porridge beans'], 145, 7.5, 20.0, 4.0, 300, '1 plate', 'Cooked with palm oil.'),
      ('Ewa agoyin', array['agoyin', 'beans and sauce'], 175, 7.0, 19.0, 8.0, 300, '1 plate with sauce', 'Mashed beans with oily pepper sauce.'),
      ('Moi moi', array['moin moin', 'moimoi', 'moin-moin'], 150, 7.0, 13.0, 7.5, 150, '1 wrap', 'Steamed bean pudding with oil.'),
      ('Akara', array['bean cake', 'kosai', 'akara balls'], 280, 10.0, 20.0, 18.0, 30, '1 ball', 'Deep fried bean fritter.'),
      ('Brown beans, dry', array['dry beans', 'honey beans', 'oloyin', 'brown beans'], 340, 22.5, 55.0, 1.6, null, null, 'Dry, uncooked; for recipes.'),
      -- Eggs, meat, fish
      ('Egg, boiled', array['egg', 'eggs', 'boiled egg', 'boiled eggs'], 155, 12.6, 1.1, 10.6, 50, '1 egg', 'Whole egg, shelled.'),
      ('Egg, fried', array['fried egg', 'fried eggs'], 196, 13.6, 0.8, 15.0, 50, '1 egg', 'Fried in oil.'),
      ('Suya', array['beef suya', 'tsire'], 245, 26.0, 4.0, 14.0, 70, '1 stick', 'Grilled beef with yaji; lean pieces are lower.'),
      ('Beef, stewed', array['meat', 'beef', 'stew meat'], 230, 27.0, 0.0, 13.0, 60, '1 piece', 'Boiled then fried or stewed.'),
      ('Goat meat, boiled', array['goat meat', 'asun', 'goat'], 145, 27.0, 0.0, 3.5, 60, '1 piece', 'Boiled; asun adds oil.'),
      ('Chicken, fried', array['fried chicken', 'chicken'], 250, 25.0, 6.0, 14.0, 100, '1 piece', 'With skin, deep fried.'),
      ('Chicken, stewed', array['stewed chicken', 'chicken in stew'], 215, 25.0, 0.0, 12.5, 100, '1 piece', 'With skin.'),
      ('Turkey, fried', array['turkey', 'turkey wing'], 230, 26.0, 0.0, 14.0, 100, '1 piece', 'With skin, fried.'),
      ('Fish, fried', array['fish', 'titus', 'mackerel', 'fried fish', 'croaker'], 260, 24.0, 0.0, 18.0, 100, '1 piece', 'Mackerel-type fish, fried.'),
      ('Ponmo', array['kpomo', 'cow skin'], 130, 28.0, 0.0, 2.0, 50, '1 piece', 'Boiled cow skin.'),
      -- Stews and soups
      ('Tomato stew', array['stew', 'red stew', 'obe ata'], 140, 1.5, 7.0, 12.0, 100, '2 cooking spoons', 'Tomato and pepper stew with typical oil, no meat.'),
      ('Egusi soup', array['egusi'], 230, 8.5, 5.0, 20.0, 200, '1 bowl', 'Melon seed soup with palm oil, no meat.'),
      ('Efo riro', array['efo', 'vegetable soup'], 140, 6.0, 5.0, 11.0, 200, '1 bowl', 'Spinach stew with palm oil, no meat.'),
      ('Okra soup', array['okro', 'okra', 'okro soup'], 85, 4.5, 6.0, 5.0, 200, '1 bowl', 'With some palm oil, no meat.'),
      ('Ogbono soup', array['ogbono', 'draw soup'], 210, 7.0, 6.0, 18.0, 200, '1 bowl', 'With palm oil, no meat.'),
      ('Ewedu', array['ewedu soup'], 35, 2.5, 4.0, 1.0, 150, '1 bowl', 'Jute leaf soup, little oil.'),
      ('Pepper soup', array['goat pepper soup', 'fish pepper soup', 'catfish pepper soup'], 70, 9.0, 1.5, 3.0, 300, '1 bowl', 'Broth with its meat or fish.'),
      -- Vegetables and fruit
      ('Cabbage, raw', array['cabbage'], 25, 1.3, 5.8, 0.1, 50, '1 handful, shredded', 'Raw.'),
      ('Carrot', array['carrots'], 41, 0.9, 9.6, 0.2, 60, '1 medium carrot', 'Raw.'),
      ('Tomato and pepper blend', array['blended tomato', 'tomato pepper', 'ata lilo', 'pepper mix'], 25, 1.0, 5.0, 0.3, null, null, 'Raw blend of tomato, tatashe and scotch bonnet; for recipes.'),
      ('Garden egg', array['garden eggs', 'african eggplant'], 25, 1.0, 6.0, 0.2, 60, '1 garden egg', 'Raw.'),
      ('Orange', array['oranges'], 47, 0.9, 11.8, 0.1, 130, '1 medium, peeled', 'Raw.'),
      ('Banana', array['bananas'], 89, 1.1, 22.8, 0.3, 120, '1 medium, peeled', 'Raw.'),
      ('Pineapple', array['pineapples'], 50, 0.5, 13.0, 0.1, 150, '1 cup of chunks', 'Raw.'),
      ('Watermelon', array['water melon'], 30, 0.6, 7.6, 0.2, 300, '1 large slice', 'Raw, no rind.'),
      ('Pawpaw', array['papaya'], 43, 0.5, 11.0, 0.3, 150, '1 cup', 'Raw.'),
      -- Snacks
      ('Groundnuts, roasted', array['groundnut', 'groundnuts', 'peanuts', 'roasted groundnuts'], 585, 24.0, 21.0, 49.0, 30, '1 small sachet', 'Dry roasted.'),
      ('Chin chin', array['chinchin', 'chin-chin'], 480, 7.0, 60.0, 23.0, 50, '1 small pack', 'Fried dough snack.'),
      ('Puff puff', array['puff-puff', 'puffpuff'], 340, 6.0, 45.0, 15.0, 30, '1 ball', 'Fried dough ball.'),
      ('Meat pie', array['meatpie'], 290, 7.0, 30.0, 16.0, 140, '1 pie', 'Bakery meat pie.'),
      ('Sausage roll', array['gala', 'gala sausage roll'], 320, 7.5, 32.0, 18.0, 60, '1 roll', 'Packaged sausage roll; the pack states its own figures.'),
      -- Fats, sugar and milk (also for hidden items)
      ('Palm oil', array['red oil', 'red palm oil'], 884, 0.0, 0.0, 100.0, 15, '1 tablespoon', 'Pure oil.'),
      ('Vegetable oil', array['oil', 'groundnut oil', 'soybean oil', 'cooking oil'], 884, 0.0, 0.0, 100.0, 15, '1 tablespoon', 'Pure oil.'),
      ('Sugar', array['white sugar', 'cube sugar'], 400, 0.0, 100.0, 0.0, 4, '1 teaspoon', 'Pure sugar.'),
      ('Evaporated milk', array['peak milk', 'milk', 'tin milk'], 135, 6.8, 10.0, 7.6, 30, '2 tablespoons', 'Unsweetened, full cream.'),
      ('Milk powder', array['powdered milk', 'dano', 'peak powder'], 496, 26.0, 38.0, 27.0, 15, '2 tablespoons', 'Full cream.'),
      ('Cocoa malt drink powder', array['milo', 'bournvita', 'ovaltine'], 400, 8.0, 77.0, 7.0, 20, '2 heaped teaspoons', 'Powder only.'),
      -- Drinks
      ('Zobo', array['zobo drink', 'hibiscus drink'], 45, 0.1, 11.0, 0.0, 350, '1 bottle (35 cl)', 'Sweetened; homemade varies a lot.'),
      ('Soft drink', array['coke', 'pepsi', 'fanta', 'sprite', 'minerals'], 42, 0.0, 10.6, 0.0, 350, '1 bottle (35 cl)', 'Regular, not diet.'),
      ('Malt drink', array['malt', 'maltina', 'amstel malta'], 55, 0.3, 13.0, 0.0, 330, '1 can', 'Non-alcoholic malt.'),
      ('Drinking yoghurt', array['yoghurt', 'yogurt', 'hollandia'], 85, 3.0, 13.5, 2.0, 315, '1 bottle', 'Sweetened.')
    ) as f(name, aliases, kcal, protein, carbs, fat, portion_g, portion_label, note)
  on conflict (user_id, lower(name)) do nothing;

  -- -------------------------------------------------------------------------
  -- The Beans pot
  -- -------------------------------------------------------------------------
  insert into recipes (user_id, name, portions, notes)
  values (v_owner, 'Beans pot', 5, 'Batch-cooked. Weigh the cooked pot once and enter it as the cooked weight to get grams per portion right.')
  on conflict (user_id, lower(name)) do nothing;

  select id into v_recipe from recipes where user_id = v_owner and lower(name) = 'beans pot';

  if not exists (select 1 from recipe_ingredients where recipe_id = v_recipe) then
    insert into recipe_ingredients (user_id, recipe_id, food_id, grams, position)
    select v_owner, v_recipe, f.id, i.grams, i.pos
      from (values ('brown beans, dry', 1000, 0), ('palm oil', 54, 1), ('carrot', 150, 2), ('tomato and pepper blend', 300, 3))
           as i(food, grams, pos)
      join foods f on f.user_id = v_owner and lower(f.name) = i.food;
  end if;

  -- -------------------------------------------------------------------------
  -- Saved meals
  -- -------------------------------------------------------------------------
  insert into saved_meals (user_id, name, items, meal_slot, sort_order)
  values (v_owner, 'Beans container', jsonb_build_array(jsonb_build_object('recipe_id', v_recipe, 'portions', 1)), 'lunch', 0)
  on conflict (user_id, lower(name)) do nothing;

  insert into saved_meals (user_id, name, items, meal_slot, sort_order)
  select v_owner, '3 boiled eggs + 1 plantain',
         jsonb_build_array(jsonb_build_object('food_id', e.id, 'grams', 150), jsonb_build_object('food_id', p.id, 'grams', 180)),
         'breakfast', 1
    from foods e, foods p
   where e.user_id = v_owner and lower(e.name) = 'egg, boiled'
     and p.user_id = v_owner and lower(p.name) = 'plantain, boiled'
  on conflict (user_id, lower(name)) do nothing;

  -- -------------------------------------------------------------------------
  -- Settings: the Meals page's target, carried over; the rest left blank
  -- -------------------------------------------------------------------------
  begin
    select value into v_target from user_settings where key = 'calorie_target' and user_id = v_owner limit 1;
  exception when undefined_column or undefined_table then
    v_target := null;
  end;
  insert into diet_settings (user_id, kcal_target)
  values (v_owner, case when v_target ~ '^\s*\d{3,4}\s*$' and v_target::integer between 1000 and 6000 then v_target::integer end)
  on conflict (user_id) do nothing;

  raise notice 'diet seed: % foods, % recipes, % saved meals for the owner',
    (select count(*) from foods where user_id = v_owner),
    (select count(*) from recipes where user_id = v_owner),
    (select count(*) from saved_meals where user_id = v_owner);
end
$$;


-- ---------------------------------------------------------------------------
-- Verify: one portion of the Beans pot, priced the way meal_items will be
-- ---------------------------------------------------------------------------

do $$
declare
  p record;
begin
  if exists (select 1 from foods where source like 'Estimate:%' and not estimated) then
    raise exception 'a food whose source says Estimate is not marked estimated';
  end if;

  select d.* into p
    from recipes r, lateral diet_recipe_portion(r.id) d
   where lower(r.name) = 'beans pot'
   limit 1;
  if not found then
    raise notice 'diet seed not verified: no Beans pot (the seed was skipped; see the notice above)';
    return;
  end if;
  -- (3400 + 477.4 + 61.5 + 75) / 5 = 802.8 kcal; (225 + 1.35 + 3) / 5 = 45.9 g protein
  if round(p.kcal) <> 803 or round(p.protein_g, 1) <> 45.9 then
    raise exception 'Beans pot: one portion should be 803 kcal and 45.9 g protein, got % and %', round(p.kcal), round(p.protein_g, 1);
  end if;
  raise notice 'diet seed verified: one Beans pot portion is % kcal, % g protein', round(p.kcal), round(p.protein_g, 1);
end
$$;
