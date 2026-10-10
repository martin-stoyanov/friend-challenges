import { useState } from 'react';

const EMOJIS = ['🔥', '😂', '💪', '🎉', '✨', '🤪', '💥', '🎯', '👯', '❤️'];

interface Particle {
  id: number;
  emoji: string;
  left: number;
  duration: number;
  delay: number;
}

function makeParticles(): Particle[] {
  return Array.from({ length: 15 }, (_, i) => ({
    id: i,
    emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
    left: Math.random() * 100,
    duration: 4 + Math.random() * 6,
    delay: Math.random() * 5,
  }));
}

export default function EmojiRain() {
  // Lazy initializer: the random layout is rolled once per mount, with no
  // empty first render followed by a second one from an effect.
  const [particles] = useState(makeParticles);

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
