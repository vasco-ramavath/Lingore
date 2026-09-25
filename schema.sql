-- LINGORE REAL MVP DATABASE
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default 'Lingore User',
  native_language text not null default 'English',
  target_language text not null default 'English',
  level text not null default 'Beginner' check (level in ('Beginner','Intermediate','Advanced')),
  current_streak integer not null default 0,
  longest_streak integer not null default 0,
  last_conversation_date date,
  total_conversations integer not null default 0,
  total_seconds bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.match_queue (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  target_language text not null,
  level text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer not null default 0,
  status text not null default 'active' check (status in ('active','ended'))
);

create table if not exists public.blocks (
  blocker_id uuid references public.profiles(id) on delete cascade,
  blocked_id uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  details text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.match_queue enable row level security;
alter table public.calls enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;

drop policy if exists "profile self read" on public.profiles;
create policy "profile self read" on public.profiles for select to authenticated using (id=auth.uid());
drop policy if exists "profile self insert" on public.profiles;
create policy "profile self insert" on public.profiles for insert to authenticated with check (id=auth.uid());
drop policy if exists "profile self update" on public.profiles;
create policy "profile self update" on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid());

drop policy if exists "queue self" on public.match_queue;
create policy "queue self" on public.match_queue for all to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());

drop policy if exists "calls participant read" on public.calls;
create policy "calls participant read" on public.calls for select to authenticated using (user_a=auth.uid() or user_b=auth.uid());

drop policy if exists "blocks self" on public.blocks;
create policy "blocks self" on public.blocks for all to authenticated using (blocker_id=auth.uid()) with check (blocker_id=auth.uid());

drop policy if exists "reports insert" on public.reports;
create policy "reports insert" on public.reports for insert to authenticated with check (reporter_id=auth.uid());

-- Automatically create a profile after Google sign-in.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,name)
  values(new.id, coalesce(new.raw_user_meta_data->>'full_name','Lingore User'))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- Atomically match two waiting users. This prevents two clients taking the same partner.
create or replace function public.find_or_queue_match(p_native_language text, p_target_language text, p_level text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  me uuid := auth.uid();
  peer uuid;
  call_id uuid;
begin
  if me is null then raise exception 'Not authenticated'; end if;

  -- Match A with B when B speaks the language A wants and B wants the language A speaks.
  select q.user_id into peer
  from public.match_queue q
  join public.profiles p on p.id=q.user_id
  where q.user_id <> me
    and q.target_language = p_native_language
    and p.native_language = p_target_language
    and q.level = p_level
    and not exists (select 1 from public.blocks b where b.blocker_id=me and b.blocked_id=q.user_id)
    and not exists (select 1 from public.blocks b where b.blocker_id=q.user_id and b.blocked_id=me)
  order by q.created_at
  for update of q skip locked limit 1;

  if peer is null then
    insert into public.match_queue(user_id,target_language,level)
    values(me,p_target_language,p_level)
    on conflict(user_id) do update set target_language=excluded.target_language,level=excluded.level,created_at=now();
    return jsonb_build_object('matched',false);
  end if;

  delete from public.match_queue where user_id in (me,peer);
  insert into public.calls(user_a,user_b) values(me,peer) returning id into call_id;

  -- Wake the waiting peer immediately through Supabase Realtime.
  perform realtime.send(
    jsonb_build_object('call_id',call_id,'peer_id',me,'initiator',false),
    'matched',
    'match:'||peer::text,
    true
  );

  return jsonb_build_object('matched',true,'call_id',call_id,'peer_id',peer,'initiator',true);
end $$;

grant execute on function public.find_or_queue_match(text,text,text) to authenticated;

create or replace function public.leave_match_queue()
returns void language sql security definer set search_path=public as $$
  delete from public.match_queue where user_id=auth.uid();
$$;
grant execute on function public.leave_match_queue() to authenticated;

-- End a call and update the caller's real statistics + streak.
create or replace function public.finish_call(p_call_id uuid, p_seconds integer)
returns void language plpgsql security definer set search_path=public as $$
declare
  me uuid := auth.uid();
  today date := current_date;
  call_started timestamptz;
  actual_seconds integer;
begin
  select started_at into call_started from public.calls
  where id=p_call_id and (user_a=me or user_b=me) and status='active'
  for update;

  if call_started is null then return; end if;

  actual_seconds := greatest(0, least(coalesce(p_seconds,0), extract(epoch from (now()-call_started))::integer + 5));

  update public.calls
    set ended_at=now(), duration_seconds=actual_seconds, status='ended'
  where id=p_call_id and status='active';

  update public.profiles
    set total_conversations=total_conversations+1,
        total_seconds=total_seconds+actual_seconds,
        current_streak=case
          when last_conversation_date = today then current_streak
          when last_conversation_date = today-1 then current_streak+1
          else 1 end,
        longest_streak=greatest(longest_streak,
          case when last_conversation_date=today then current_streak
               when last_conversation_date=today-1 then current_streak+1
               else 1 end),
        last_conversation_date=today
  where id=me;
end $$;
grant execute on function public.finish_call(uuid,integer) to authenticated;


-- Realtime Authorization:
-- Only the matched user may join match:<their-user-id>.
drop policy if exists "lingore match topic read" on realtime.messages;
create policy "lingore match topic read"
on realtime.messages for select to authenticated
using (
  (select realtime.topic()) = 'match:' || (select auth.uid())::text
  and realtime.messages.extension = 'broadcast'
);

drop policy if exists "lingore match topic write" on realtime.messages;
create policy "lingore match topic write"
on realtime.messages for insert to authenticated
with check (
  (select realtime.topic()) = 'match:' || (select auth.uid())::text
  and realtime.messages.extension = 'broadcast'
);

-- Only call participants may join or signal on call:<call-id>.
drop policy if exists "lingore call topic read" on realtime.messages;
create policy "lingore call topic read"
on realtime.messages for select to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1 from public.calls c
    where ('call:' || c.id::text) = (select realtime.topic())
      and (c.user_a = (select auth.uid()) or c.user_b = (select auth.uid()))
  )
);

drop policy if exists "lingore call topic write" on realtime.messages;
create policy "lingore call topic write"
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1 from public.calls c
    where ('call:' || c.id::text) = (select realtime.topic())
      and (c.user_a = (select auth.uid()) or c.user_b = (select auth.uid()))
  )
);

-- Realtime authorization for private call/match channels.
-- In Supabase Dashboard: Realtime -> Settings -> disable public channel access if you want private-only.
