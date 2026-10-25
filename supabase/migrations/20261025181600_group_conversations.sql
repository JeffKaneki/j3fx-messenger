create or replace function public.create_group_conversation(group_title text, member_usernames text[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_conversation uuid;
declare requested_count integer;
declare found_count integer;
begin
  if auth.uid() is null or char_length(trim(group_title)) not between 1 and 80 then
    raise exception 'A group name is required';
  end if;
  requested_count := coalesce(array_length(member_usernames, 1), 0);
  if requested_count < 1 or requested_count > 49 then
    raise exception 'Add between one and 49 other members';
  end if;
  select count(*) into found_count from public.profiles
    where username = any(select lower(trim(value)) from unnest(member_usernames) value)
      and id <> auth.uid();
  if found_count <> requested_count then
    raise exception 'One or more usernames were not found';
  end if;
  insert into public.conversations(title, is_group) values (trim(group_title), true)
    returning id into new_conversation;
  insert into public.conversation_members(conversation_id, user_id)
    select new_conversation, id from public.profiles
      where username = any(select lower(trim(value)) from unnest(member_usernames) value)
        and id <> auth.uid();
  insert into public.conversation_members(conversation_id, user_id)
    values (new_conversation, auth.uid());
  return new_conversation;
end;
$$;
revoke all on function public.create_group_conversation(text, text[]) from public;
grant execute on function public.create_group_conversation(text, text[]) to authenticated;
