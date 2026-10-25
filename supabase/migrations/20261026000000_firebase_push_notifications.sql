create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null unique check (char_length(token) between 1 and 4096),
  platform text not null check (platform in ('android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_devices_user_id_idx on public.push_devices(user_id);

alter table public.push_devices enable row level security;

create policy "users manage their own push devices"
  on public.push_devices
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.push_devices from public, anon;
grant select, insert, update, delete on public.push_devices to authenticated;
grant all on public.push_devices to service_role;
