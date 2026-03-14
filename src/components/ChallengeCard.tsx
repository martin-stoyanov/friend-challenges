import { motion } from 'framer-motion';
import type { Challenge } from '@/types/Challenge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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

export default function ChallengeCard({ challenge, featured = false }: Props) {
  const categoryClasses = getCategoryClasses(challenge.category);

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      whileHover={{ scale: featured ? 1.02 : 1.04, rotate: featured ? 0 : challenge.id.charCodeAt(challenge.id.length - 1) % 2 === 0 ? 1 : -1 }}
    >
      <Card className={cn(
        'overflow-hidden transition-all border-2',
        featured
          ? 'rainbow-border shadow-2xl'
          : 'hover:border-electric-purple/60'
      )}>
        {featured && (
          <div className="bg-gradient-to-r from-hot-pink via-electric-purple to-sky-blue py-2 px-4 text-center">
            <span className="font-display text-lg text-white tracking-wider">
              ✨ THIS WEEK'S CHALLENGE ✨
            </span>
          </div>
        )}

        <CardHeader className="flex-row items-center gap-3">
          <span className={cn(featured ? 'text-5xl wobble' : 'text-4xl')}>
            {challenge.emoji}
          </span>
          <div>
            <CardTitle className={cn('font-display leading-tight', featured ? 'text-3xl' : 'text-2xl')}>
              {challenge.title}
            </CardTitle>
            <CardDescription className="mt-1">
              Week of {formatWeekOf(challenge.weekOf)}
            </CardDescription>
          </div>
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
            {featured && (
              <Badge variant="outline" className="bg-hot-pink/20 text-hot-pink border-hot-pink/30">
                📱 via {challenge.trendSource}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
