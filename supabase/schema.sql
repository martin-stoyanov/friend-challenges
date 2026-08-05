-- ============================================================================
-- Friend Challenges — Supabase schema (ratings + completions)
-- ============================================================================
-- Run this whole file once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run).
--
-- After running it, finish the setup:
--   1. Auth → Providers → make sure "Email" is enabled (it is by default).
--      Email confirmation is ON by default: new sign-ups must click a link
--      before they can log in. To skip that while testing, turn off
--      Auth → Providers → Email → "Confirm email".
--   2. Auth → URL Configuration → set Site URL and add these Redirect URLs
--      (used by confirmation links):
--        http://localhost:5173
--        https://friend-challenges.netlify.app
--   3. Dashboard → Settings → API Keys (or the "Connect" button): copy the
--      Project URL and the Publishable key (sb_publishable_...) into .env
--      (see .env.example) and into Netlify env vars
--      (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY). The publishable key
--      replaced the legacy "anon" key; it's safe to ship client-side because
--      RLS (below) enforces access. Never use the secret key here.
--
-- challenge_id is TEXT and references the `id` field in src/data/challenges.json.
-- challenges.json stays the source of truth for challenge content; only the
-- per-user ratings/completions live here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ratings: one 1..5 star rating per user per challenge
-- ---------------------------------------------------------------------------
create table if not exists public.ratings (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  challenge_id text        not null,
  stars        int         not null check (stars between 1 and 5),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, challenge_id)
);

-- ---------------------------------------------------------------------------
-- completions: presence of a row = "I did this challenge"
-- ---------------------------------------------------------------------------
create table if not exists public.completions (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  challenge_id text        not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, challenge_id)
);

-- ---------------------------------------------------------------------------
-- Row-Level Security: each user may only see/modify their own rows.
-- ---------------------------------------------------------------------------
alter table public.ratings     enable row level security;
alter table public.completions enable row level security;

-- ratings policies
drop policy if exists "own ratings - select" on public.ratings;
create policy "own ratings - select" on public.ratings
  for select using (auth.uid() = user_id);

drop policy if exists "own ratings - insert" on public.ratings;
create policy "own ratings - insert" on public.ratings
  for insert with check (auth.uid() = user_id);

drop policy if exists "own ratings - update" on public.ratings;
create policy "own ratings - update" on public.ratings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own ratings - delete" on public.ratings;
create policy "own ratings - delete" on public.ratings
  for delete using (auth.uid() = user_id);

-- completions policies
drop policy if exists "own completions - select" on public.completions;
create policy "own completions - select" on public.completions
  for select using (auth.uid() = user_id);

drop policy if exists "own completions - insert" on public.completions;
create policy "own completions - insert" on public.completions
  for insert with check (auth.uid() = user_id);

drop policy if exists "own completions - delete" on public.completions;
create policy "own completions - delete" on public.completions
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- rating_stats: public aggregate (average + count) per challenge.
-- Exposes NO per-user data, so anon + authenticated may read it. This is what
-- powers the "4.3★ from 42 people" crowd average shown to everyone, including
-- signed-out visitors.
--
-- security_invoker = on makes the view run with the caller's privileges, but
-- since it only aggregates and we grant SELECT below, no individual rows leak.
-- ---------------------------------------------------------------------------
create or replace view public.rating_stats
  with (security_invoker = off) as
  select
    challenge_id,
    round(avg(stars)::numeric, 2) as avg_stars,
    count(*)                      as num_ratings
  from public.ratings
  group by challenge_id;

grant select on public.rating_stats to anon, authenticated;
