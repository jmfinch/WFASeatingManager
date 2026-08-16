import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

import { SeatingProvider } from '@/context/seating-context';
import Host from '@/pages/host';
import Setup from '@/pages/setup';
import Display from '@/pages/display';
import History from '@/pages/history';
import Viewer from '@/pages/viewer';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  const [location] = useLocation();

  // Viewer is a standalone read-only screen — no SeatingProvider needed.
  // Safe to share publicly; has no path to host controls.
  if (location === '/viewer') return <Viewer />;

  return (
    <SeatingProvider>
      <Switch>
        <Route path="/" component={Host} />
        <Route path="/setup" component={Setup} />
        <Route path="/display" component={Display} />
        <Route path="/history" component={History} />
        <Route component={NotFound} />
      </Switch>
    </SeatingProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <RoutedErrorBoundary>
            <Router />
          </RoutedErrorBoundary>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
