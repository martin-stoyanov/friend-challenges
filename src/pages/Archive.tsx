import { useState } from 'react';
import { motion } from 'framer-motion';
import challenges from '@/data/challenges.json';
import type { Challenge } from '@/types/Challenge';
import ChallengeCard from '@/components/ChallengeCard';
import { Button } from '@/components/ui/button';
import { cn, sortByWeekDesc, sortByRatingDesc } from '@/lib/utils';
import { useAuth } from '@/contexts/auth-context';
import { useProgress } from '@/contexts/progress-context';

const typedChallenges = challenges as Challenge[];

type Filter = 'all' | 'friend' | 'couple' | 'both';
type StatusFilter = 'all' | 'done' | 'not-done' | 'rated';
type SortBy = 'recent' | 'rating';

const statusFilters: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '🌟 Any status' },
  { value: 'done', label: '✅ Done' },
  { value: 'not-done', label: '🔲 Not done' },
  { value: 'rated', label: '⭐ Rated by me' },
];

const filters: { value: Filter; label: string; activeClass: string; inactiveClass: string }[] = [
  { value: 'all', label: '🌈 All', activeClass: 'bg-electric-purple text-white shadow-lg hover:bg-electric-purple/80', inactiveClass: 'text-electric-purple border-electric-purple/40 hover:border-electric-purple hover:bg-electric-purple/10' },
  { value: 'friend', label: '👫 Friends', activeClass: 'bg-neon-green text-black shadow-lg hover:bg-neon-green/80', inactiveClass: 'text-neon-green border-neon-green/40 hover:border-neon-green hover:bg-neon-green/10' },
  { value: 'couple', label: '💕 Couples', activeClass: 'bg-hot-pink text-white shadow-lg hover:bg-hot-pink/80', inactiveClass: 'text-hot-pink border-hot-pink/40 hover:border-hot-pink hover:bg-hot-pink/10' },
  { value: 'both', label: '🎉 Everyone', activeClass: 'bg-sunny-yellow text-black shadow-lg hover:bg-sunny-yellow/80', inactiveClass: 'text-sunny-yellow border-sunny-yellow/40 hover:border-sunny-yellow hover:bg-sunny-yellow/10' },
];

export default function Archive() {
  const [filter, setFilter] = useState<Filter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('recent');

  const { user, configured } = useAuth();
  const { myRatings, doneIds, stats } = useProgress();
  const canFilterByStatus = configured && Boolean(user);

  const sorted = sortBy === 'rating'
    ? sortByRatingDesc(typedChallenges, stats)
    : sortByWeekDesc(typedChallenges);

  const byCategory = filter === 'all'
    ? sorted
    : sorted.filter((c) => c.category === filter || c.category === 'both');

  const filtered = byCategory.filter((c) => {
    if (!canFilterByStatus || statusFilter === 'all') return true;
    if (statusFilter === 'done') return doneIds.has(c.id);
    if (statusFilter === 'not-done') return !doneIds.has(c.id);
    if (statusFilter === 'rated') return Boolean(myRatings[c.id]);
    return true;
  });

  return (
    <div className="relative z-10">
      {/* Header */}
      <section className="text-center py-10 px-6">
        <motion.h2
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="font-display text-5xl sm:text-6xl text-white mb-3"
        >
          📚 CHALLENGE ARCHIVE
        </motion.h2>
        <p className="font-body text-lg text-muted-foreground">
          Every challenge we've ever dropped. Pick one and get going!
        </p>
      </section>

      {/* Filters */}
      <section className="max-w-5xl mx-auto px-6 pb-6">
        <div className="flex flex-wrap gap-3 justify-center">
          {filters.map((f) => (
            <motion.div key={f.value} whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
              <Button
                variant={filter === f.value ? 'default' : 'outline'}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'rounded-full font-bold',
                  filter === f.value ? f.activeClass : f.inactiveClass
                )}
              >
                {f.label}
              </Button>
            </motion.div>
          ))}
        </div>

        {/* Status filters + sort — only meaningful with a signed-in user */}
        {configured && (
          <div className="mt-4 flex flex-wrap gap-3 justify-center items-center">
            {canFilterByStatus &&
              statusFilters.map((f) => (
                <motion.div key={f.value} whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
                  <Button
                    size="sm"
                    variant={statusFilter === f.value ? 'default' : 'outline'}
                    onClick={() => setStatusFilter(f.value)}
                    className={cn(
                      'rounded-full font-bold',
                      statusFilter === f.value
                        ? 'bg-neon-green text-black shadow-lg hover:bg-neon-green/80'
                        : 'text-neon-green border-neon-green/40 hover:border-neon-green hover:bg-neon-green/10'
                    )}
                  >
                    {f.label}
                  </Button>
                </motion.div>
              ))}
            <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSortBy((s) => (s === 'rating' ? 'recent' : 'rating'))}
                className={cn(
                  'rounded-full font-bold',
                  sortBy === 'rating'
                    ? 'bg-sunny-yellow text-black shadow-lg hover:bg-sunny-yellow/80'
                    : 'text-sunny-yellow border-sunny-yellow/40 hover:border-sunny-yellow hover:bg-sunny-yellow/10'
                )}
              >
                {sortBy === 'rating' ? '⭐ Top rated' : '🕒 Most recent'}
              </Button>
            </motion.div>
          </div>
        )}
      </section>

      {/* Challenge Grid */}
      <section className="max-w-5xl mx-auto px-6 pb-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filtered.map((c) => (
            <ChallengeCard key={c.id} challenge={c} />
          ))}
        </div>

        {filtered.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16"
          >
            <p className="font-display text-3xl text-muted-foreground">No challenges found 😢</p>
            <p className="font-body text-muted-foreground mt-2">Try a different filter!</p>
          </motion.div>
        )}
      </section>
    </div>
  );
}
