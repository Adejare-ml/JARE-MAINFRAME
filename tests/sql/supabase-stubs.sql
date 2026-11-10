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

-- Supabase Storage, the smallest version of it (added for the Diet module,
-- Phase 3, whose migration 052 creates the private meal-photos bucket and
-- its policies). The real storage schema has more columns and its own API
-- in front; the policies 052 writes need only these, and
-- storage.foldername behaves as Supabase's does: the path's folders,
-- without the file name.
create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  created_at timestamptz default now()
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable
as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to authenticated, service_role;
