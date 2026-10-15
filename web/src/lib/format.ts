export function formatTokens(n: number): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number | null | undefined, partial = false): string {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return partial ? '$0.00+' : '$0.00';
  if (usd < 0.01) return `<$0.01${partial ? '+' : ''}`;
  return `$${usd.toFixed(2)}${partial ? '+' : ''}`;
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function relPath(abs: string, root: string): string {
  if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
  if (abs === root) return '.';
  return abs;
}

export function modelLabel(ref: string): string {
  const [provider, ...rest] = ref.split('/');
  const id = rest.join('/');
  return id ? `${id}` : provider ?? ref;
}

export function providerOf(ref: string): string {
  return ref.split('/')[0] ?? '';
}

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', xml: 'xml', svg: 'xml', vue: 'html',
  dockerfile: 'dockerfile', lua: 'lua', dart: 'dart', scala: 'scala', r: 'r', graphql: 'graphql', gql: 'graphql', ps1: 'powershell', sol: 'solidity',
};

export function languageFor(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'shell';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return LANGS[ext] ?? 'plaintext';
}

export function classNames(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
