-- ============================================================================
-- 019_goal_icon.sql
--
-- One nullable column: an optional emoji for a goal card. Nothing else in this
-- migration, because that is the whole feature -- goals already have a title,
-- and this is decoration on top of it, not a new kind of row.
--
-- Idempotent; safe to re-run. No RLS change: 003/009/010/011 already put
-- goals behind `auth.uid() = user_id`, and a nullable text column adds
-- nothing a policy needs to know about.
-- ============================================================================

alter table goals add column if not exists icon text;

-- Short on purpose: long enough for any emoji (including multi-codepoint ones
-- like a family emoji, which is several codepoints joined with ZWJ) and short
-- enough that a stray paste of real text does not turn a card's icon slot
-- into a second title.
alter table goals drop constraint if exists goals_icon_length;
alter table goals add  constraint goals_icon_length
  check (icon is null or char_length(icon) <= 8);


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'goals' and column_name = 'icon'
  ) then
    raise exception 'goals.icon was not created';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'goals_icon_length'
  ) then
    raise exception 'goals_icon_length constraint was not created';
  end if;

  raise notice 'goals.icon verified: present and length-checked';
end
$$;
