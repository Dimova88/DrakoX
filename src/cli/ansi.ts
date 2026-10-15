const enabled = (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR) || Boolean(process.env.FORCE_COLOR);

const wrap = (open: string, close: string) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
const rgb = (r: number, g: number, b: number) => (s: string) => (enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s);

export const c = {
  enabled,
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  underline: wrap('4', '24'),
  inverse: wrap('7', '27'),
  strike: wrap('9', '29'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
  white: wrap('97', '39'),
  rgb,
  /** DrakoX ember */
  brand: rgb(255, 107, 53),
  /** DrakoX violet */
  accent: rgb(167, 139, 250),
  ok: rgb(52, 211, 153),
  warn: rgb(251, 191, 36),
  err: rgb(248, 113, 113),
  added: rgb(74, 222, 128),
  removed: rgb(248, 113, 113),
  hunk: rgb(103, 232, 249),
};

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function termWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns || 100, 160));
}

export function modeColor(mode: string): (s: string) => string {
  switch (mode) {
    case 'plan':
      return c.hunk;
    case 'auto-edit':
      return c.warn;
    case 'autopilot':
      return c.err;
    default:
      return c.ok;
  }
}

export const MODE_LABEL: Record<string, string> = {
  plan: '⏸ plan',
  ask: '◆ ask',
  'auto-edit': '⏵ auto-edit',
  autopilot: '⏵⏵ autopilot',
};

export const MODE_HELP: Record<string, string> = {
  plan: 'read-only research → plan for approval',
  ask: 'asks before edits & risky commands',
  'auto-edit': 'edits files freely, asks for risky commands',
  autopilot: 'runs everything except hard-blocked actions',
};

export const LOGO = [
  '  ____            _          __  __',
  ' |  _ \\ _ __ __ _| | _____   \\ \\/ /',
  " | | | | '__/ _` | |/ / _ \\   \\  / ",
  ' | |_| | | | (_| |   < (_) |  /  \\ ',
  ' |____/|_|  \\__,_|_|\\_\\___/  /_/\\_\\',
];

export function logo(): string {
  const shades = [rgb(255, 140, 60), rgb(255, 120, 55), rgb(255, 100, 60), rgb(250, 85, 80), rgb(235, 75, 110)];
  return LOGO.map((l, i) => shades[i]!(l)).join('\n');
}
