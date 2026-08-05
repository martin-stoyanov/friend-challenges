import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/auth-context';
import { ProgressContext, type RatingStat } from '@/contexts/progress-context';

export function ProgressProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [myRatings, setMyRatings] = useState<Record<string, number>>({});
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<Record<string, RatingStat>>({});
  const [loading, setLoading] = useState(false);

  // Public crowd stats — load once (and refresh after a rating), no auth needed.
  const loadStats = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from('rating_stats')
      .select('challenge_id, avg_stars, num_ratings');
    if (error || !data) return;
    const next: Record<string, RatingStat> = {};
    for (const row of data) {
      next[row.challenge_id as string] = {
        avgStars: Number(row.avg_stars),
        numRatings: Number(row.num_ratings),
      };
    }
    setStats(next);
  }, []);

  // Load the signed-in user's own ratings + completions. Passing `null` clears
  // them (used on sign-out). Kept as a plain async fn so the effect below never
  // sets state synchronously in its body.
  const loadMine = useCallback(async (userId: string | null) => {
    if (!supabase || !userId) {
      setMyRatings({});
      setDoneIds(new Set());
      return;
    }
    setLoading(true);
    const [{ data: ratings }, { data: completions }] = await Promise.all([
      supabase.from('ratings').select('challenge_id, stars').eq('user_id', userId),
      supabase.from('completions').select('challenge_id').eq('user_id', userId),
    ]);
    const r: Record<string, number> = {};
    for (const row of ratings ?? []) r[row.challenge_id as string] = row.stars as number;
    setMyRatings(r);
    setDoneIds(new Set((completions ?? []).map((c) => c.challenge_id as string)));
    setLoading(false);
  }, []);

  // Synchronizing React with Supabase (an external system) — the supported use
  // of effects. State updates happen inside the async callbacks, so the
  // set-state-in-effect rule's cascading-render concern doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMine(user?.id ?? null);
  }, [user, loadMine]);

  const rate = useCallback(
    async (challengeId: string, stars: number) => {
      if (!supabase || !user) return;
      const prev = myRatings[challengeId];
      setMyRatings((m) => ({ ...m, [challengeId]: stars })); // optimistic
      const { error } = await supabase
        .from('ratings')
        .upsert(
          { user_id: user.id, challenge_id: challengeId, stars, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,challenge_id' },
        );
      if (error) {
        setMyRatings((m) => {
          const next = { ...m };
          if (prev === undefined) delete next[challengeId];
          else next[challengeId] = prev;
          return next;
        });
        return;
      }
      loadStats();
    },
    [user, myRatings, loadStats],
  );

  const toggleDone = useCallback(
    async (challengeId: string) => {
      if (!supabase || !user) return;
      const wasDone = doneIds.has(challengeId);
      setDoneIds((s) => {
        const next = new Set(s);
        if (wasDone) next.delete(challengeId);
        else next.add(challengeId);
        return next;
      });
      const { error } = wasDone
        ? await supabase
            .from('completions')
            .delete()
            .eq('user_id', user.id)
            .eq('challenge_id', challengeId)
        : await supabase
            .from('completions')
            .upsert(
              { user_id: user.id, challenge_id: challengeId },
              { onConflict: 'user_id,challenge_id' },
            );
      if (error) {
        setDoneIds((s) => {
          const next = new Set(s);
          if (wasDone) next.add(challengeId);
          else next.delete(challengeId);
          return next;
        });
      }
    },
    [user, doneIds],
  );

  return (
    <ProgressContext.Provider
      value={{ myRatings, doneIds, stats, loading, rate, toggleDone }}
    >
      {children}
    </ProgressContext.Provider>
  );
}
