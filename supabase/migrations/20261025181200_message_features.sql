alter table public.messages
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz;

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reaction text not null check (reaction in ('heart','like','laugh','sad')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, reaction)
);
create table if not exists public.conversation_reads (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
alter table public.message_reactions enable row level security;
alter table public.conversation_reads enable row level security;
create policy "members can read reactions" on public.message_reactions for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id)));
create policy "members can react" on public.message_reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id)));
create policy "users remove own reactions" on public.message_reactions for delete to authenticated using (user_id = auth.uid());
create policy "members can read cursors" on public.conversation_reads for select to authenticated using (public.is_conversation_member(conversation_id));
create policy "users write own cursors" on public.conversation_reads for insert to authenticated with check (user_id = auth.uid() and public.is_conversation_member(conversation_id));
create policy "users update own cursors" on public.conversation_reads for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_conversation_member(conversation_id));
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions') then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_reads') then
    alter publication supabase_realtime add table public.conversation_reads;
  end if;
end $$;

create or replace function public.touch_conversation() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set updated_at = new.created_at where id = new.conversation_id;
  return new;
end; $$;
drop trigger if exists on_message_created on public.messages;
create trigger on_message_created after insert on public.messages for each row execute procedure public.touch_conversation();
