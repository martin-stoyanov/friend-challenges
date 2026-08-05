import { useState } from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  /** The current user's own rating (1-5), or 0/undefined if unrated. */
  value: number;
  onRate: (stars: number) => void;
  /** When false the stars render as a static display (e.g. signed-out). */
  interactive?: boolean;
  /** Tooltip shown when not interactive (e.g. "Sign in to rate"). */
  disabledHint?: string;
  size?: number;
}

export default function StarRating({
  value,
  onRate,
  interactive = true,
  disabledHint,
  size = 22,
}: Props) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;

  return (
    <div
      className="inline-flex items-center gap-0.5"
      onMouseLeave={() => setHover(0)}
      title={!interactive ? disabledHint : undefined}
      role={interactive ? 'radiogroup' : undefined}
      aria-label="Your rating"
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= shown;
        return (
          <button
            key={star}
            type="button"
            disabled={!interactive}
            aria-label={`${star} star${star > 1 ? 's' : ''}`}
            aria-checked={value === star}
            role={interactive ? 'radio' : undefined}
            onMouseEnter={() => interactive && setHover(star)}
            onClick={() => interactive && onRate(star)}
            className={cn(
              'transition-transform',
              interactive ? 'cursor-pointer hover:scale-125' : 'cursor-default',
            )}
          >
            <Star
              size={size}
              className={cn(
                'transition-colors',
                filled
                  ? 'fill-sunny-yellow text-sunny-yellow'
                  : 'fill-transparent text-muted-foreground/40',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
