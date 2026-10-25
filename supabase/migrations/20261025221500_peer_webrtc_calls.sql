drop table if exists public.call_sessions cascade;

create table public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  callee_id uuid not null references public.profiles(id) on delete cascade,
  call_type text not null check (call_type in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'accepted', 'declined', 'missed', 'ended')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz not null,
  ended_at timestamptz,
  check (caller_id <> callee_id),
  check (expires_at > created_at)
);

create index call_sessions_callee_status_created_idx
  on public.call_sessions(callee_id, status, created_at desc);
create index call_sessions_caller_status_created_idx
  on public.call_sessions(caller_id, status, created_at desc);
create unique index call_sessions_one_active_per_caller_idx
  on public.call_sessions(caller_id) where status in ('ringing', 'accepted');
create unique index call_sessions_one_active_per_callee_idx
  on public.call_sessions(callee_id) where status in ('ringing', 'accepted');

create table public.call_signals (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  from_user uuid not null references public.profiles(id) on delete cascade,
  signal_type text not null check (signal_type in ('offer', 'answer', 'candidate')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object'),
  check (
    (signal_type = 'offer' and payload->>'type' = 'offer' and jsonb_typeof(payload->'sdp') = 'string')
    or (signal_type = 'answer' and payload->>'type' = 'answer' and jsonb_typeof(payload->'sdp') = 'string')
    or (signal_type = 'candidate' and jsonb_typeof(payload->'candidate') = 'string')
  ),
  check (octet_length(payload::text) <= 32768)
);

create index call_signals_call_created_idx on public.call_signals(call_id, created_at);
alter table public.call_sessions enable row level security;
alter table public.call_signals enable row level security;

create policy "call participants can read their sessions"
  on public.call_sessions for select to authenticated
  using (auth.uid() in (caller_id, callee_id));

create policy "call participants can read signaling"
  on public.call_signals for select to authenticated
  using (
    exists (
      select 1 from public.call_sessions s
      where s.id = call_id and auth.uid() in (s.caller_id, s.callee_id)
    )
  );

create policy "active call participants can send signaling"
  on public.call_signals for insert to authenticated
  with check (
    from_user = auth.uid()
    and exists (
      select 1 from public.call_sessions s
      where s.id = call_id
        and auth.uid() in (s.caller_id, s.callee_id)
        and s.status = 'accepted'
        and s.expires_at > now()
        and (
          (signal_type = 'offer' and s.caller_id = auth.uid())
          or (signal_type = 'answer' and s.callee_id = auth.uid())
          or signal_type = 'candidate'
        )
    )
  );

create or replace function public.start_peer_call(target_conversation uuid, requested_call_type text)
returns public.call_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  participants uuid[];
  callee uuid;
  started public.call_sessions;
begin
  if caller is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if requested_call_type not in ('audio', 'video') then
    raise exception 'Unsupported call type' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.conversations
    where id = target_conversation and is_group = false
  ) then
    raise exception 'Calls are only supported in direct conversations' using errcode = '22023';
  end if;

  select array_agg(user_id order by user_id) into participants
  from public.conversation_members
  where conversation_id = target_conversation;
  if coalesce(array_length(participants, 1), 0) <> 2 or not caller = any(participants) then
    raise exception 'A direct conversation with exactly two members is required' using errcode = '42501';
  end if;
  select user_id into callee
  from public.conversation_members
  where conversation_id = target_conversation and user_id <> caller;

  perform pg_advisory_xact_lock(hashtextextended(participants[1]::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(participants[2]::text, 0));

  update public.call_sessions
  set status = case when status = 'ringing' then 'missed' else 'ended' end,
      ended_at = now()
  where status in ('ringing', 'accepted')
    and expires_at <= now()
    and (caller_id = any(participants) or callee_id = any(participants));

  if exists (
    select 1 from public.call_sessions
    where status in ('ringing', 'accepted')
      and expires_at > now()
      and (caller_id = any(participants) or callee_id = any(participants))
  ) then
    raise exception 'One of the participants is already in a call' using errcode = '23505';
  end if;

  insert into public.call_sessions(conversation_id, caller_id, callee_id, call_type, expires_at)
  values (target_conversation, caller, callee, requested_call_type, now() + interval '60 seconds')
  returning * into started;
  return started;
end;
$$;

revoke all on function public.start_peer_call(uuid, text) from public, anon;
grant execute on function public.start_peer_call(uuid, text) to authenticated;

grant select on public.call_sessions to authenticated;
grant select, insert on public.call_signals to authenticated;
grant all on public.call_sessions, public.call_signals to service_role;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'call_sessions'
  ) then
    alter publication supabase_realtime add table public.call_sessions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'call_signals'
  ) then
    alter publication supabase_realtime add table public.call_signals;
  end if;
end $$;
