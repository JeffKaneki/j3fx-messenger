alter table public.conversation_members
  add column if not exists is_admin boolean not null default false;

create table if not exists public.message_receipts (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delivered_at timestamptz,
  read_at timestamptz,
  primary key (message_id, user_id)
);
create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 52428800),
  created_at timestamptz not null default now()
);
create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now()
);
alter table public.message_receipts enable row level security;
alter table public.message_attachments enable row level security;
alter table public.user_blocks enable row level security;
alter table public.user_reports enable row level security;
create policy "members read receipts" on public.message_receipts for select to authenticated using (exists (select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id)));
create policy "recipients write receipts" on public.message_receipts for insert to authenticated with check (user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id)));
create policy "members read attachments" on public.message_attachments for select to authenticated using (public.is_conversation_member((select conversation_id from public.messages where id = message_id)));
create policy "members create attachments" on public.message_attachments for insert to authenticated with check (owner_id = auth.uid() and public.is_conversation_member((select conversation_id from public.messages where id = message_id)));
create policy "users manage own blocks" on public.user_blocks for all to authenticated using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());
create policy "users create reports" on public.user_reports for insert to authenticated with check (reporter_id = auth.uid());
insert into storage.buckets (id, name, public) values ('message-media', 'message-media', false) on conflict (id) do nothing;
create policy "members upload private message media" on storage.objects for insert to authenticated with check (bucket_id = 'message-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "members read private message media" on storage.objects for select to authenticated using (bucket_id = 'message-media' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function public.mark_message_delivered(target_message uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.message_receipts(message_id, user_id, delivered_at)
    values (target_message, auth.uid(), now())
    on conflict (message_id, user_id) do update set delivered_at = coalesce(message_receipts.delivered_at, excluded.delivered_at);
end; $$;
revoke all on function public.mark_message_delivered(uuid) from public;
grant execute on function public.mark_message_delivered(uuid) to authenticated;

create or replace function public.leave_conversation(target_conversation uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.conversation_members where conversation_id = target_conversation and user_id = auth.uid();
$$;
revoke all on function public.leave_conversation(uuid) from public;
grant execute on function public.leave_conversation(uuid) to authenticated;
