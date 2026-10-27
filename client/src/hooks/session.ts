import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, getCurrentUser, register, signIn, signOut } from '@/lib/api';
import type { User } from '@/lib/types';

export const SESSION_KEY = ['session'] as const;
const REMEMBERED_KEY = 'stillnote.user';

function readRemembered(): User | null {
  try {
    const user = JSON.parse(localStorage.getItem(REMEMBERED_KEY) || 'null');
    return user && typeof user.id === 'string' && typeof user.email === 'string' ? user : null;
  } catch {
    return null;
  }
}

function remember(user: User | null) {
  try {
    if (user) localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ id: user.id, email: user.email }));
    else localStorage.removeItem(REMEMBERED_KEY);
  } catch {
    // Remembering the user is best-effort.
  }
}

/** The signed-in user, `null` when signed out. Works offline from the last known user. */
export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<User | null> => {
      try {
        const user = await getCurrentUser();
        remember(user);
        return user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          remember(null);
          return null;
        }
        // Server unreachable: keep working from the last signed-in user's offline copy.
        return readRemembered();
      }
    },
  });
}

export function useSignIn(mode: 'signin' | 'register') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => (mode === 'register' ? register : signIn)(email, password),
    onSuccess: (user) => {
      remember(user);
      client.setQueryData(SESSION_KEY, user);
    },
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => signOut().catch(() => undefined),
    onSettled: () => {
      remember(null);
      client.setQueryData(SESSION_KEY, null);
    },
  });
}

/** Marks the session ended without a round trip, e.g. after a 401 from any request. */
export function expireSession(client: ReturnType<typeof useQueryClient>) {
  remember(null);
  client.setQueryData(SESSION_KEY, null);
}
