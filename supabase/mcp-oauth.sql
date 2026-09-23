-- ============================================================================
-- Work Tracker — Claude Connector (remote MCP server) OAuth storage
-- ============================================================================
-- Run this in the Supabase SQL editor ONCE, before connecting Claude.
--
-- It creates the three tables the connector's OAuth 2.1 flow needs:
--   mcp_oauth_clients — OAuth clients (Claude registers itself via DCR)
--   mcp_oauth_codes   — short-lived authorization codes (PKCE)
--   mcp_oauth_tokens  — issued MCP access + refresh tokens
--
-- SECURITY MODEL
-- --------------
-- These tables are ONLY ever read and written by the Netlify Functions, which
-- use the service-role key. Row Level Security is enabled and deliberately
-- given NO policies, so no browser-side client — admin or worker — can read a
-- row even with a valid session. The service-role key bypasses RLS by design,
-- which is exactly how the existing admin functions (create-worker, etc.)
-- work.
--
-- The tables hold the signed-in user's Supabase access/refresh token so every
-- tool call runs AS THAT USER (see netlify/functions/mcp.ts). That is what
-- makes the connector obey your real permissions: Claude sees exactly what the
-- account you logged in with is allowed to see, and RLS — not our own code —
-- is what enforces it.
--
-- Safe to re-run: everything is `if not exists`.
-- ============================================================================

-- ---------- OAuth clients ----------
create table if not exists public.mcp_oauth_clients (
  client_id                  text primary key,
  -- Null for public clients that authenticate with PKCE only (what Claude's
  -- Dynamic Client Registration creates). Set only when someone pre-registers
  -- a confidential client with a secret.
  client_secret_hash         text,
  name                       text,
  redirect_uris              text[] not null default '{}',
  grant_types                text[] not null default '{authorization_code,refresh_token}',
  response_types             text[] not null default '{code}',
  token_endpoint_auth_method text not null default 'none',
  scope                      text,
  created_at                 timestamptz not null default now(),
  last_seen_at               timestamptz
);

-- ---------- Authorization codes ----------
create table if not exists public.mcp_oauth_codes (
  -- Codes are stored hashed: a leaked database row is not a usable code.
  code_hash             text primary key,
  client_id             text not null,
  redirect_uri          text not null,
  code_challenge        text not null,
  code_challenge_method text not null default 'S256',
  scope                 text,
  user_id               uuid not null references auth.users (id) on delete cascade,
  -- The sign-in that authorised this code, so the token endpoint can hand the
  -- MCP session the same Supabase session and run future calls as that user.
  supabase_access_token  text not null,
  supabase_refresh_token text not null,
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists mcp_oauth_codes_expires_idx on public.mcp_oauth_codes (expires_at);

-- ---------- Issued tokens ----------
create table if not exists public.mcp_oauth_tokens (
  -- The bearer token Claude sends. Stored hashed for the same reason as codes.
  token_hash            text primary key,
  -- The refresh token that pairs with it, also stored hashed (and under a
  -- different namespace, so a leaked access-token row cannot be replayed as a
  -- refresh token). Null only if the row predates this column.
  refresh_token_hash    text,
  client_id             text not null,
  user_id               uuid not null references auth.users (id) on delete cascade,
  scope                 text,
  supabase_access_token  text not null,
  supabase_refresh_token text not null,
  -- When the Supabase session expires (from the JWT `exp`), so the function
  -- knows to refresh before a call instead of after a failure.
  supabase_expires_at   timestamptz,
  -- MCP token lifetime and refresh-token lifetime are separate: the MCP token
  -- is short (1 hour), the refresh token lasts 30 days.
  expires_at            timestamptz not null,
  refresh_expires_at    timestamptz not null,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz
);

create index if not exists mcp_oauth_tokens_expires_idx on public.mcp_oauth_tokens (expires_at);
create index if not exists mcp_oauth_tokens_user_idx on public.mcp_oauth_tokens (user_id);
create index if not exists mcp_oauth_tokens_refresh_idx
  on public.mcp_oauth_tokens (refresh_token_hash);

-- Installed on databases created before `refresh_token_hash` existed.
alter table public.mcp_oauth_tokens add column if not exists refresh_token_hash text;

-- Lock every table down. No policies = no access through the anon key, even
-- for a signed-in admin. Only the service-role key (Netlify Functions) reads
-- or writes these rows.
alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_codes   enable row level security;
alter table public.mcp_oauth_tokens  enable row level security;

-- ============================================================================
-- Maintenance: drop consumed codes and expired tokens.
--
-- The connector deletes consumed codes and expired tokens as it goes, so this
-- is belt-and-braces for rows left behind by an interrupted flow. Call it from
-- any scheduled job (or run it by hand):
--   select public.cleanup_mcp_oauth();
-- ============================================================================
create or replace function public.cleanup_mcp_oauth()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  removed bigint := 0;
  batch   bigint := 0;
begin
  delete from public.mcp_oauth_codes
   where consumed_at is not null
      or expires_at < now() - interval '1 day';
  get diagnostics batch = row_count;
  removed := removed + batch;

  delete from public.mcp_oauth_tokens
   where refresh_expires_at < now() - interval '1 day';
  get diagnostics batch = row_count;
  removed := removed + batch;

  return removed;
end;
$$;
