import { motion } from 'framer-motion';
import challenges from '@/data/challenges.json';
import type { Challenge } from '@/types/Challenge';
import ChallengeCard from '@/components/ChallengeCard';
import EmojiRain from '@/components/EmojiRain';
import { Card, CardContent } from '@/components/ui/card';
import { sortByWeekDesc } from '@/lib/utils';

const typedChallenges = challenges as Challenge[];

function getCurrentChallenge(): Challenge {
  return sortByWeekDesc(typedChallenges)[0];
}

function getRecentChallenges(): Challenge[] {
  return sortByWeekDesc(typedChallenges).slice(1, 4);
}

export default function Home() {
  const current = getCurrentChallenge();
  const recent = getRecentChallenges();

  return (
    <div className="relative z-10">
      <EmojiRain />

      {/* Hero */}
      <section className="text-center py-12 px-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, type: 'spring' }}
        >
          <h2 className="font-display text-5xl sm:text-7xl text-white mb-4 sparkle-text">
            READY TO GET
            <br />
            <span className="text-neon-green">CHALLENGED?!</span>
          </h2>
          <p className="font-body text-lg text-gray-300 max-w-xl mx-auto">
            Every week we drop one viral friend or couple challenge.
            <br />
            Try it. Film it. Tag your friends. Repeat. 🎬
          </p>
        </motion.div>
      </section>

      {/* Featured Challenge */}
      <section className="max-w-3xl mx-auto px-6 pb-12">
        <ChallengeCard challenge={current} featured />
      </section>

      {/* Recent Challenges */}
      {recent.length > 0 && (
        <section className="max-w-5xl mx-auto px-6 pb-16">
          <motion.h2
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            className="font-display text-3xl text-electric-purple mb-6"
          >
            ⚡ RECENT DROPS
          </motion.h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {recent.map((c, i) => (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.15 }}
              >
                <ChallengeCard challenge={c} />
              </motion.div>
            ))}
          </div>
        </section>
      )}

      {/* Fun CTA */}
      <section className="text-center pb-16 px-6">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
          className="max-w-lg mx-auto"
        >
          <Card className="border-2">
            <CardContent className="text-center">
              <p className="font-display text-2xl text-sunny-yellow mb-2">
                🗓️ NEW CHALLENGE EVERY WEEK
              </p>
              <p className="font-body text-muted-foreground">
                Come back every Monday for a fresh viral challenge to try with your besties or bae!
              </p>
            </CardContent>
          </Card>
        </motion.div>
      </section>
    </div>
  );
}
