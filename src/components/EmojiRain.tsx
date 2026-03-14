import { useEffect, useState } from 'react';

const EMOJIS = ['🔥', '😂', '💪', '🎉', '✨', '🤪', '💥', '🎯', '👯', '❤️'];

interface Particle {
  id: number;
  emoji: string;
  left: number;
  duration: number;
  delay: number;
}

export default function EmojiRain() {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    const newParticles: Particle[] = Array.from({ length: 15 }, (_, i) => ({
      id: i,
      emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
      left: Math.random() * 100,
      duration: 4 + Math.random() * 6,
      delay: Math.random() * 5,
    }));
    setParticles(newParticles);
  }, []);

  return (
    <>
      {particles.map((p) => (
        <span
          key={p.id}
          className="emoji-particle"
          style={{
            left: `${p.left}%`,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
          }}
        >
          {p.emoji}
        </span>
      ))}
    </>
  );
}
