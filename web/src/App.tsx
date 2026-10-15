import { lazy, Suspense, useEffect, useRef } from 'react';
import { Toaster, toast } from 'sonner';
import { AlertTriangle, ShieldQuestion, Sparkles } from 'lucide-react';
import { useStore } from './lib/store';
import { connectWs, post } from './lib/api';
import { navigate, useRoute } from './lib/route';
import { Sidebar } from './components/Sidebar';
import { MissionControl } from './views/MissionControl';
import { AgentView } from './views/AgentView';
import { Integrations } from './views/Integrations';
import { Skills } from './views/Skills';
import { Settings } from './views/Settings';
import { EventLog } from './views/EventLog';
import { CommandPalette } from './components/CommandPalette';
import { Onboarding } from './components/Onboarding';
import { Button, Spinner } from './components/ui';

const EditorView = lazy(() => import('./views/EditorView'));

export function App() {
  const route = useRoute();
  const init = useStore((s) => s.init);
  const handleWs = useStore((s) => s.handleWs);
  const info = useStore((s) => s.info);
  const theme = useStore((s) => s.theme);
  const wasConnected = useRef(false);
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    init().catch((e) => toast.error(`Could not reach DrakoX: ${e.message}`));
    return connectWs(handleWs, (ok) => {
      useStore.setState({ connected: ok });
      if (ok && wasConnected.current) {
        // re-sync after a reconnect
        void useStore.getState().refreshAgents();
        const r = routeRef.current;
        if (r.name === 'agent') void useStore.getState().loadAgent(r.id, true);
      }
      if (ok) wasConnected.current = true;
    });
  }, [init, handleWs]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !(e.target as HTMLElement)?.closest?.('.monaco-editor')) {
        e.preventDefault();
        useStore.getState().setPalette(!useStore.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <div className="flex h-full">
      <Sidebar route={route} />
      <main className="flex min-w-0 flex-1 flex-col">
        {info?.demo && route.name !== 'settings' && (
          <div className="flex shrink-0 items-center gap-2 border-b border-warn/20 bg-warn/[.06] px-4 py-1.5 text-[12.5px]">
            <Sparkles className="size-3.5 text-warn" />
            <span className="text-fg/90">You're using the offline demo model — great for a tour.</span>
            <span className="hidden text-muted md:inline">Connect a real model (free with Ollama or free tiers) to do real work.</span>
            <div className="flex-1" />
            <Button size="xs" variant="primary" onClick={() => useStore.getState().setOnboarding(true)}>
              Connect a model
            </Button>
          </div>
        )}
        {info?.needsTrust && (
          <div className="flex shrink-0 items-center gap-2 border-b border-info/20 bg-info/[.06] px-4 py-1.5 text-[12.5px]">
            <ShieldQuestion className="size-3.5 text-info" />
            <span>This project defines hooks or local MCP servers. They stay off until you trust the folder.</span>
            <div className="flex-1" />
            <Button size="xs" onClick={() => post('/api/trust', { trusted: true }).then(() => toast.success('Folder trusted'))}>
              Trust folder
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {route.name === 'mission' && <MissionControl />}
          {route.name === 'agent' && <AgentView key={route.id} id={route.id} />}
          {route.name === 'editor' && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner className="size-6" />
                </div>
              }
            >
              <EditorView file={route.file} />
            </Suspense>
          )}
          {route.name === 'integrations' && <Integrations tab={route.tab} />}
          {route.name === 'skills' && <Skills />}
          {route.name === 'settings' && <Settings tab={route.tab} />}
          {route.name === 'log' && <EventLog id={route.id} />}
        </div>
      </main>
      <CommandPalette />
      <Onboarding />
      <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" richColors closeButton toastOptions={{ style: { fontFamily: 'var(--font-sans)' } }} />
      <ErrorWatch />
    </div>
  );
}

function ErrorWatch() {
  useEffect(() => {
    const on = (e: PromiseRejectionEvent) => {
      const msg = (e.reason as Error)?.message;
      if (msg && !/abort/i.test(msg)) toast.error(msg, { icon: <AlertTriangle className="size-4" /> });
    };
    window.addEventListener('unhandledrejection', on);
    return () => window.removeEventListener('unhandledrejection', on);
  }, []);
  return null;
}

export { navigate };
