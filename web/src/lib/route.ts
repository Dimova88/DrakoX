import { useEffect, useState } from 'react';

export type Route =
  | { name: 'mission' }
  | { name: 'agent'; id: string }
  | { name: 'editor'; file?: string }
  | { name: 'integrations'; tab?: string }
  | { name: 'skills' }
  | { name: 'settings'; tab?: string }
  | { name: 'log'; id: string };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const parts = (path ?? '').split('/').filter(Boolean);
  const q = new URLSearchParams(query ?? '');
  switch (parts[0]) {
    case 'agent':
      return parts[1] ? { name: 'agent', id: decodeURIComponent(parts[1]) } : { name: 'mission' };
    case 'editor':
      return { name: 'editor', file: q.get('file') ?? undefined };
    case 'integrations':
      return { name: 'integrations', tab: parts[1] };
    case 'skills':
      return { name: 'skills' };
    case 'settings':
      return { name: 'settings', tab: parts[1] };
    case 'log':
      return parts[1] ? { name: 'log', id: decodeURIComponent(parts[1]) } : { name: 'mission' };
    default:
      return { name: 'mission' };
  }
}

export function navigate(to: string): void {
  if (location.hash !== to) location.hash = to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
