-- Notepad: strictly private notes, one list per authenticated account.
-- The admin and every worker have their own notepad; row level security
-- limits every statement to rows the caller owns, so nobody — not even the
-- admin — can read or change another person's notes.
-- Safe to run repeatedly in the Supabase SQL editor.

create table if not exists public.notepad_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null default '',
  body       text not null default '',
  color      text not null default 'default',
  pinned     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notepad_notes_user_idx on public.notepad_notes (user_id, pinned desc, updated_at desc);

alter table public.notepad_notes enable row level security;

drop policy if exists "notepad_notes_select_own" on public.notepad_notes;
create policy "notepad_notes_select_own" on public.notepad_notes for select using ((select auth.uid()) = user_id);

drop policy if exists "notepad_notes_insert_own" on public.notepad_notes;
create policy "notepad_notes_insert_own" on public.notepad_notes for insert with check ((select auth.uid()) = user_id);

drop policy if exists "notepad_notes_update_own" on public.notepad_notes;
create policy "notepad_notes_update_own" on public.notepad_notes for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "notepad_notes_delete_own" on public.notepad_notes;
create policy "notepad_notes_delete_own" on public.notepad_notes for delete using ((select auth.uid()) = user_id);

revoke all on public.notepad_notes from anon;
grant select, insert, update, delete on public.notepad_notes to authenticated;
