import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Challenge } from "@/types/Challenge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function sortByWeekDesc(challenges: Challenge[]): Challenge[] {
  return [...challenges].sort(
    (a, b) => new Date(b.weekOf).getTime() - new Date(a.weekOf).getTime()
  );
}

// Sort by crowd average rating (highest first). Unrated challenges sort last.
// statsMap maps challenge id -> average stars.
export function sortByRatingDesc(
  challenges: Challenge[],
  statsMap: Record<string, { avgStars: number }>
): Challenge[] {
  return [...challenges].sort((a, b) => {
    const ra = statsMap[a.id]?.avgStars ?? -1;
    const rb = statsMap[b.id]?.avgStars ?? -1;
    return rb - ra;
  });
}
