import { Suspense, lazy, useEffect } from 'react';
import { Link, Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { EngineProvider } from '@/hooks/engine';
import { expireSession, useSession } from '@/hooks/session';
import { setUnauthorizedHandler } from '@/lib/api';
import { applyTheme, resolveTheme, useUi } from '@/lib/ui-store';
import AuthPage from '@/routes/AuthPage';
import NotesPage from '@/routes/NotesPage';

const SettingsPage = lazy(() => import('@/routes/SettingsPage'));

const queryClient = new QueryClient();

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Loading">
      <div className="size-8 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex h-dvh flex-col" aria-busy="true">
      <div className="h-14 border-b border-border" />
      <div className="flex flex-1">
        <div className="hidden w-80 space-y-3 border-r border-border p-3 md:block">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
        <div className="flex-1 space-y-4 px-8 pt-10">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

function RequireAuth() {
  const { data: user, isPending } = useSession();
  if (isPending) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <EngineProvider userId={user.id} fallback={<ShellSkeleton />}>
      <AppShell />
    </EngineProvider>
  );
}

function NotFound() {
  return (
    <div className="m-auto text-center">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-1 text-sm text-muted-foreground">That address does not lead anywhere.</p>
      <Button asChild variant="primary" className="mt-4">
        <Link to="/notes">Back to your notes</Link>
      </Button>
    </div>
  );
}

const router = createBrowserRouter([
  { path: '/login', element: <AuthPage /> },
  {
    element: <RequireAuth />,
    children: [
      { index: true, element: <Navigate to="/notes" replace /> },
      { path: 'notes', element: <NotesPage /> },
      { path: 'notes/:id', element: <NotesPage /> },
      {
        path: 'settings',
        element: (
          <Suspense fallback={null}>
            <SettingsPage />
          </Suspense>
        ),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

function useThemeEffect() {
  const theme = useUi((state) => state.theme);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);
}

function Providers() {
  const client = useQueryClient();
  const theme = useUi((state) => state.theme);
  useThemeEffect();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      expireSession(client);
      toast('Your session has ended. Sign in again to keep syncing.');
    });
    return () => setUnauthorizedHandler(null);
  }, [client]);

  return (
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster
        position="bottom-center"
        theme={resolveTheme(theme)}
        toastOptions={{ classNames: { toast: '!rounded-xl !border-border !bg-card !text-card-foreground' } }}
      />
    </TooltipProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Providers />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
