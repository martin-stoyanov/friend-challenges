export interface Challenge {
  id: string;
  weekOf: string;
  title: string;
  description: string;
  category: 'friend' | 'couple' | 'both';
  difficulty: 'easy' | 'medium' | 'hard';
  emoji: string;
  trendSource: string;
  players: string;
  timeEstimate: string;
}
