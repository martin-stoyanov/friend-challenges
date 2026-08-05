import { createContext, useContext } from 'react';
import type { User } from '@supabase/supabase-js';

export interface AuthResult {
  error: string | null;
  /** True when sign-up succeeded but the account still needs email confirmation. */
  needsConfirmation?: boolean;
}

export interface AuthState {
  user: User | null;
  loading: boolean;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signUp: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
