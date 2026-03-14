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
