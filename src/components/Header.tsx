import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function Header() {
  const location = useLocation();

  return (
    <header className="relative z-10 py-6 px-6">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <Link to="/" className="no-underline">
          <motion.h1
            className="font-display text-4xl sm:text-5xl text-hot-pink tracking-wide sparkle-text cursor-pointer"
            whileHover={{ scale: 1.05, rotate: -2 }}
            whileTap={{ scale: 0.95 }}
          >
            🔥 Friend Challenges
          </motion.h1>
        </Link>

        <nav className="flex gap-3">
          <Link to="/">
            <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
              <Button
                variant={location.pathname === '/' ? 'default' : 'outline'}
                size="lg"
                className={cn(
                  'rounded-full font-bold',
                  location.pathname === '/'
                    ? 'bg-hot-pink text-white shadow-lg shadow-hot-pink/30 hover:bg-hot-pink/80'
                    : 'text-hot-pink border-hot-pink/40 hover:border-hot-pink hover:bg-hot-pink/10'
                )}
              >
                This Week
              </Button>
            </motion.div>
          </Link>
          <Link to="/archive">
            <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
              <Button
                variant={location.pathname === '/archive' ? 'default' : 'outline'}
                size="lg"
                className={cn(
                  'rounded-full font-bold',
                  location.pathname === '/archive'
                    ? 'bg-electric-purple text-white shadow-lg shadow-electric-purple/30 hover:bg-electric-purple/80'
                    : 'text-electric-purple border-electric-purple/40 hover:border-electric-purple hover:bg-electric-purple/10'
                )}
              >
                Archive
              </Button>
            </motion.div>
          </Link>
        </nav>
      </div>
    </header>
  );
}
