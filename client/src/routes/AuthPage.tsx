import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/AppShell';
import { useSession, useSignIn } from '@/hooks/session';
import { ApiError } from '@/lib/api';

export default function AuthPage() {
  const { data: user, isPending } = useSession();
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = useSignIn(mode);
  const creating = mode === 'register';

  if (!isPending && user) return <Navigate to="/notes" replace />;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!submit.isPending) submit.mutate({ email, password });
  };
  const error =
    submit.error instanceof ApiError
      ? submit.error.isNetwork
        ? 'Cannot reach the server. Check your connection and try again.'
        : submit.error.message
      : submit.error?.message;

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-3">
          <Logo className="size-10" />
          <div>
            <div className="text-lg font-semibold tracking-tight">Stillnote</div>
            <div className="text-xs text-muted-foreground">A quieter place to think</div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="rounded-2xl border border-border bg-card p-6 shadow-pop" noValidate>
          <h1 className="text-lg font-semibold tracking-tight">{creating ? 'Create your account' : 'Welcome back'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {creating ? 'Your notes stay private to your account.' : 'Sign in to open your notes.'}
          </p>

          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <label htmlFor="auth-email" className="mt-5 block text-sm font-medium">
            Email
          </label>
          <Input
            id="auth-email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="mt-1.5"
          />

          <label htmlFor="auth-password" className="mt-4 block text-sm font-medium">
            Password
          </label>
          <Input
            id="auth-password"
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            required
            aria-describedby={creating ? 'password-hint' : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1.5"
          />
          {creating && (
            <p id="password-hint" className="mt-1.5 text-xs text-muted-foreground">
              At least 10 characters.
            </p>
          )}

          <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" disabled={submit.isPending || !email || !password}>
            {submit.isPending && <LoaderCircle className="size-4 animate-spin" />}
            {creating ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-5 text-center text-sm text-muted-foreground">
          {creating ? 'Already have an account?' : 'New to Stillnote?'}{' '}
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => {
              setMode(creating ? 'signin' : 'register');
              submit.reset();
            }}
          >
            {creating ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </div>
    </div>
  );
}
