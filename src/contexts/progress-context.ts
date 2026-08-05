import { createContext, useContext } from 'react';

export interface RatingStat {
  avgStars: number;
  numRatings: number;
}

export interface ProgressState {
  /** The signed-in user's own star rating per challenge id. */
  myRatings: Record<string, number>;
  /** Challenge ids the signed-in user has marked done. */
  doneIds: Set<string>;
  /** Public crowd average per challenge id (visible to everyone). */
  stats: Record<string, RatingStat>;
  loading: boolean;
  rate: (challengeId: string, stars: number) => Promise<void>;
  toggleDone: (challengeId: string) => Promise<void>;
}

export const ProgressContext = createContext<ProgressState | undefined>(undefined);

export function useProgress(): ProgressState {
  const ctx = useContext(ProgressContext);
  if (!ctx) throw new Error('useProgress must be used within a ProgressProvider');
  return ctx;
}
