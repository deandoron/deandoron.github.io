-- Run this once in Supabase SQL Editor for the apartment board app.
-- This intentionally allows the public publishable key to read and write this board.
-- The website password is a convenience gate, not strong database security.

create table if not exists public.apartment_board_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.apartment_board_state enable row level security;

grant select, insert, update, delete on table public.apartment_board_state to anon, authenticated;

drop policy if exists apartment_board_state_select on public.apartment_board_state;
create policy apartment_board_state_select
  on public.apartment_board_state
  for select
  to anon, authenticated
  using (id = 'main');

drop policy if exists apartment_board_state_insert on public.apartment_board_state;
create policy apartment_board_state_insert
  on public.apartment_board_state
  for insert
  to anon, authenticated
  with check (id = 'main');

drop policy if exists apartment_board_state_update on public.apartment_board_state;
create policy apartment_board_state_update
  on public.apartment_board_state
  for update
  to anon, authenticated
  using (id = 'main')
  with check (id = 'main');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apartment-board-images',
  'apartment-board-images',
  true,
  52428800,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists apartment_board_images_select on storage.objects;
create policy apartment_board_images_select
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'apartment-board-images');

drop policy if exists apartment_board_images_insert on storage.objects;
create policy apartment_board_images_insert
  on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'apartment-board-images');

drop policy if exists apartment_board_images_update on storage.objects;
create policy apartment_board_images_update
  on storage.objects
  for update
  to anon, authenticated
  using (bucket_id = 'apartment-board-images')
  with check (bucket_id = 'apartment-board-images');

drop policy if exists apartment_board_images_delete on storage.objects;
create policy apartment_board_images_delete
  on storage.objects
  for delete
  to anon, authenticated
  using (bucket_id = 'apartment-board-images');
