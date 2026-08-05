import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import type { Challenge } from '@/types/Challenge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import StarRating from '@/components/StarRating';
import { useAuth } from '@/contexts/auth-context';
import { useProgress } from '@/contexts/progress-context';

interface Props {
  challenge: Challenge;
  featured?: boolean;
}

function getCategoryClasses(category: Challenge['category']) {
  switch (category) {
    case 'friend': return 'bg-neon-green/20 text-neon-green border-neon-green/30';
    case 'couple': return 'bg-hot-pink/20 text-hot-pink border-hot-pink/30';
    case 'both': return 'bg-electric-purple/20 text-electric-purple border-electric-purple/30';
  }
}

function getCategoryLabel(category: Challenge['category']) {
  switch (category) {
    case 'friend': return '👫 Friends';
    case 'couple': return '💕 Couples';
    case 'both': return '🎉 Everyone';
  }
}

function getDifficultyStars(difficulty: Challenge['difficulty']) {
  switch (difficulty) {
    case 'easy': return '⭐';
    case 'medium': return '⭐⭐';
    case 'hard': return '⭐⭐⭐';
  }
}

function formatWeekOf(dateStr: string) {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Only allow http(s) links to avoid javascript:/data: URLs sneaking in via
// AI-generated data. React doesn't sanitize href schemes on its own.
function getSafeUrl(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

export default function ChallengeCard({ challenge, featured = false }: Props) {
  const categoryClasses = getCategoryClasses(challenge.category);
  const safeUrl = getSafeUrl(challenge.exampleUrl);

  const { user, configured } = useAuth();
  const { myRatings, doneIds, stats, rate, toggleDone } = useProgress();
  const canInteract = configured && Boolean(user);
  const myRating = myRatings[challenge.id] ?? 0;
  const isDone = doneIds.has(challenge.id);
  const stat = stats[challenge.id];

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      whileHover={{ scale: featured ? 1.02 : 1.04, rotate: featured ? 0 : challenge.id.charCodeAt(challenge.id.length - 1) % 2 === 0 ? 1 : -1 }}
    >
      <Card className={cn(
        'relative overflow-hidden transition-all border-2',
        featured
          ? 'rainbow-border shadow-2xl'
          : 'hover:border-electric-purple/60',
        isDone && 'ring-2 ring-neon-green/70'
      )}>
        {featured && (
          <div className="bg-gradient-to-r from-hot-pink via-electric-purple to-sky-blue py-2 px-4 text-center">
            <span className="font-display text-lg text-white tracking-wider">
              ✨ THIS WEEK'S CHALLENGE ✨
            </span>
          </div>
        )}

        <CardHeader className="flex flex-row items-start gap-3">
          <span className={cn(featured ? 'text-5xl wobble' : 'text-4xl')}>
            {challenge.emoji}
          </span>
          <div className="flex-1 min-w-0">
            <CardTitle className={cn('font-display leading-tight', featured ? 'text-3xl' : 'text-2xl')}>
              {challenge.title}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
              <CardDescription className="whitespace-nowrap">
                Week of {formatWeekOf(challenge.weekOf)}
              </CardDescription>
              {safeUrl && (
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'inline-flex items-center gap-1 font-body text-sm transition-colors',
                    'text-sky-blue/80 hover:text-sky-blue'
                  )}
                >
                  ▶ Watch
                </a>
              )}
            </div>
          </div>
          {configured && (
            <button
              type="button"
              onClick={() => toggleDone(challenge.id)}
              disabled={!canInteract}
              aria-pressed={isDone}
              aria-label={isDone ? 'Mark as not done' : 'Mark as done'}
              title={
                canInteract
                  ? isDone
                    ? 'Mark as not done'
                    : 'Mark as done'
                  : 'Sign in to track what you’ve done'
              }
              className={cn(
                'grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 transition-colors',
                canInteract ? 'cursor-pointer' : 'cursor-default',
                isDone
                  ? 'border-neon-green/70 bg-neon-green/10 text-neon-green'
                  : 'border-border/60 text-muted-foreground/50 hover:border-neon-green/50 hover:text-neon-green'
              )}
            >
              <Check size={18} strokeWidth={3} className={cn(!isDone && 'opacity-40')} />
            </button>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          <p className={cn('font-body leading-relaxed text-muted-foreground', featured ? 'text-lg' : 'text-base')}>
            {challenge.description}
          </p>

          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className={categoryClasses}>
              {getCategoryLabel(challenge.category)}
            </Badge>
            <Badge variant="outline" className="bg-sunny-yellow/20 text-sunny-yellow border-sunny-yellow/30">
              {getDifficultyStars(challenge.difficulty)} {challenge.difficulty}
            </Badge>
            <Badge variant="outline" className="bg-sky-blue/20 text-sky-blue border-sky-blue/30">
              👥 {challenge.players}
            </Badge>
            <Badge variant="outline" className="bg-neon-green/20 text-neon-green border-neon-green/30">
              ⏱️ {challenge.timeEstimate}
            </Badge>
          </div>

          {configured && (
            <div className="flex items-center gap-2 pt-3 border-t border-border/40">
              <StarRating
                value={myRating}
                onRate={(stars) => rate(challenge.id, stars)}
                interactive={canInteract}
                disabledHint="Sign in to rate"
                size={16}
              />
              <span className="font-body text-sm text-muted-foreground">
                {stat
                  ? `${stat.avgStars.toFixed(1)}★ · ${stat.numRatings}`
                  : 'No ratings'}
              </span>
            </div>
          )}

        </CardContent>
      </Card>
    </motion.div>
  );
}
