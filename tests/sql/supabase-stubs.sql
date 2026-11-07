-- What a plain Postgres needs before the Supabase migrations will run.
--
-- The migrations under supabase/migrations assume a Supabase project: an
-- `auth` schema with a users table and auth.uid(), the anon / authenticated
-- / service_role roles the grants and policies name, the supabase_realtime
-- publication, the supabase_migrations ledger (033 and 034 use it when it
-- is there), and pg_cron (a stub extension, installed by scripts/db-test.mjs
-- from tests/sql/pg_cron-stub). Everything here is the smallest thing that
-- makes those statements true; none of it changes what the migrations do.
--
-- auth.uid() reads the same request.jwt.claims setting the migrations' own
-- verify blocks set (028, 029), so a test can act as the owner with
--   select set_config('request.jwt.claims', '{"sub":"<uuid>"}', false);

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'supabase_read_only_user'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version    text primary key,
  statements text[],
  name       text
);

-- Supabase grants every table, sequence and function in public to the three
-- API roles by default privilege, and the migrations then revoke what the
-- browser must not reach (035 on jare_owner, 044 on the audit functions).
-- Without the same default, a revoke proves nothing.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
