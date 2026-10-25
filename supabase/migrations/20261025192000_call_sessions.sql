create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  room_name text not null unique,
  room_url text not null,
  call_type text not null check (call_type in ('audio', 'video')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz not null,
  ended_at timestamptz,
  check (expires_at > created_at)
);

create index if not exists call_sessions_conversation_created_idx
  on public.call_sessions(conversation_id, created_at desc);

alter table public.call_sessions enable row level security;

drop policy if exists "conversation members can view call sessions" on public.call_sessions;
create policy "conversation members can view call sessions"
  on public.call_sessions for select to authenticated
  using (public.is_conversation_member(conversation_id));

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'call_sessions'
  ) then
    alter publication supabase_realtime add table public.call_sessions;
  end if;
end $$;
