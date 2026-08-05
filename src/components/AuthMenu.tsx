import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/auth-context';

export default function AuthMenu() {
  const { user, signIn, signUp, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    return (
      <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
        <Button
          variant="outline"
          size="lg"
          onClick={() => signOut()}
          title={user.email ?? undefined}
          className="rounded-full font-bold text-sky-blue border-sky-blue/40 hover:border-sky-blue hover:bg-sky-blue/10"
        >
          Sign out
        </Button>
      </motion.div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = mode === 'login' ? await signIn(email, password) : await signUp(email, password);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.needsConfirmation) {
      setNotice('Check your email to confirm your account, then log in.');
      setMode('login');
      setPassword('');
      return;
    }
    // Signed in — onAuthStateChange will flip this component to the signed-in view.
    setOpen(false);
    setEmail('');
    setPassword('');
  };

  return (
    <div className="relative">
      <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
        <Button
          variant="default"
          size="lg"
          onClick={() => setOpen((o) => !o)}
          className="rounded-full font-bold bg-sky-blue text-white shadow-lg shadow-sky-blue/30 hover:bg-sky-blue/80"
        >
          Sign in
        </Button>
      </motion.div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            className="absolute right-0 mt-2 w-72 rounded-2xl border-2 border-sky-blue/40 bg-card p-4 shadow-2xl z-50"
          >
            <div className="mb-3 flex gap-2">
              {(['login', 'signup'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setError(null);
                    setNotice(null);
                  }}
                  className={cn(
                    'flex-1 rounded-full py-1.5 text-sm font-bold transition-colors',
                    mode === m
                      ? 'bg-sky-blue text-white'
                      : 'text-sky-blue/70 hover:text-sky-blue'
                  )}
                >
                  {m === 'login' ? 'Log in' : 'Sign up'}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="flex flex-col gap-2">
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-sky-blue"
              />
              <input
                type="password"
                required
                minLength={6}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-sky-blue"
              />

              {error && <p className="text-xs text-hot-pink">{error}</p>}
              {notice && <p className="text-xs text-neon-green">{notice}</p>}

              <Button
                type="submit"
                disabled={busy}
                className="mt-1 rounded-full font-bold bg-sky-blue text-white hover:bg-sky-blue/80"
              >
                {busy ? '…' : mode === 'login' ? 'Log in' : 'Create account'}
              </Button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
