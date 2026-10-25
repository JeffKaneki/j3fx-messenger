alter table public.profiles
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists theme text not null default 'mist',
  add column if not exists bio text;

alter table public.conversation_members
  add column if not exists nickname text;

create or replace function public.mark_conversation_read(target_conversation uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_conversation_member(target_conversation) then
    raise exception 'Not a conversation member';
  end if;
  insert into public.conversation_reads(conversation_id, user_id, last_read_at)
    values (target_conversation, auth.uid(), now())
    on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;
  update public.message_receipts r
    set read_at = now()
    from public.messages m
    where r.message_id = m.id
      and m.conversation_id = target_conversation
      and m.sender_id <> auth.uid()
      and r.user_id = auth.uid()
      and r.delivered_at is not null
      and r.read_at is null;
  update public.profiles set last_seen_at = now() where id = auth.uid();
end; $$;
revoke all on function public.mark_conversation_read(uuid) from public;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

create or replace function public.touch_presence()
returns void language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;
revoke all on function public.touch_presence() from public;
grant execute on function public.touch_presence() to authenticated;

insert into storage.buckets (id, name, public) values ('profile-media', 'profile-media', false) on conflict (id) do nothing;
drop policy if exists "users manage own profile media" on storage.objects;
create policy "users manage own profile media" on storage.objects for all to authenticated
  using (bucket_id = 'profile-media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'profile-media' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users update own conversation nicknames" on public.conversation_members;
create policy "users update own conversation nicknames" on public.conversation_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "conversation members read message media" on storage.objects;
create policy "conversation members read message media" on storage.objects for select to authenticated
  using (
    bucket_id = 'message-media'
    and exists (
      select 1
      from public.message_attachments a
      join public.messages m on m.id = a.message_id
      where a.storage_path = name
        and public.is_conversation_member(m.conversation_id)
    )
  );
