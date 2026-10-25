create or replace function public.start_direct_conversation(target_username text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare target_user uuid;
declare existing_conversation uuid;
declare new_conversation uuid;
begin
  select id into target_user from public.profiles
    where username = lower(trim(target_username)) and id <> auth.uid();
  if target_user is null then
    raise exception 'No other account exists with that username';
  end if;

  select cm.conversation_id into existing_conversation
    from public.conversation_members cm
    where cm.user_id in (auth.uid(), target_user)
    group by cm.conversation_id
    having count(*) = 2
      and count(*) filter (where cm.user_id = auth.uid()) = 1
      and count(*) filter (where cm.user_id = target_user) = 1
    limit 1;
  if existing_conversation is not null then return existing_conversation; end if;

  insert into public.conversations default values returning id into new_conversation;
  insert into public.conversation_members(conversation_id, user_id)
    values (new_conversation, auth.uid()), (new_conversation, target_user);
  return new_conversation;
end;
$$;
revoke all on function public.start_direct_conversation(text) from public;
grant execute on function public.start_direct_conversation(text) to authenticated;

create policy "senders can update own messages" on public.messages
  for update to authenticated using (sender_id = auth.uid()) with check (sender_id = auth.uid());
create policy "senders can delete own messages" on public.messages
  for delete to authenticated using (sender_id = auth.uid());
