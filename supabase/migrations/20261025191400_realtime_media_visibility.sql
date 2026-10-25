alter table public.message_attachments enable row level security;

drop policy if exists "authenticated users can read profile avatars" on storage.objects;
create policy "authenticated users can read profile avatars"
on storage.objects for select to authenticated
using (bucket_id = 'profile-media');

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_attachments') then
    alter publication supabase_realtime add table public.message_attachments;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_members') then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles') then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

create or replace function public.mark_message_delivered(target_message uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.message_receipts(message_id, user_id, delivered_at)
    values (target_message, auth.uid(), now())
    on conflict (message_id, user_id) do nothing;
end; $$;
