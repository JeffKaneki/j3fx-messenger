create or replace function public.add_group_member(target_conversation uuid, target_username text)
returns void language plpgsql security definer set search_path = public as $$
declare target_user uuid;
begin
  if not exists (select 1 from public.conversation_members where conversation_id = target_conversation and user_id = auth.uid() and is_admin) then
    raise exception 'Only group admins can add members';
  end if;
  if not exists (select 1 from public.conversations where id = target_conversation and is_group) then
    raise exception 'This is not a group conversation';
  end if;
  select id into target_user from public.profiles where username = lower(trim(target_username));
  if target_user is null then raise exception 'Username not found'; end if;
  insert into public.conversation_members(conversation_id, user_id) values (target_conversation, target_user) on conflict do nothing;
end; $$;

create or replace function public.remove_group_member(target_conversation uuid, target_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.conversation_members where conversation_id = target_conversation and user_id = auth.uid() and is_admin) then
    raise exception 'Only group admins can remove members';
  end if;
  delete from public.conversation_members where conversation_id = target_conversation and user_id = target_user and user_id <> auth.uid();
end; $$;

create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from auth.users where id = auth.uid();
end; $$;
revoke all on function public.add_group_member(uuid, text), public.remove_group_member(uuid, uuid), public.delete_my_account() from public;
grant execute on function public.add_group_member(uuid, text), public.remove_group_member(uuid, uuid), public.delete_my_account() to authenticated;
