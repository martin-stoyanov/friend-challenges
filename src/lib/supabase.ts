import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// Publishable key (sb_publishable_...), the client-side key that replaced the
// legacy "anon" key. Safe to ship in the bundle — data access is guarded by RLS.
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

// The app is designed to build and render even before Supabase is configured.
// When the env vars are missing we expose `supabase = null` and every feature
// that needs it degrades to a signed-out / read-only state instead of crashing.
export const isSupabaseConfigured = Boolean(url && publishableKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, publishableKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
