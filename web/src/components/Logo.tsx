export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="dxg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8a3d" />
          <stop offset="0.55" stopColor="#ff5a36" />
          <stop offset="1" stopColor="#e11d6a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="#111115" />
      <path d="M14 14 L26 14 L32 24 L38 14 L50 14 L38 32 L50 50 L38 50 L32 40 L26 50 L14 50 L26 32 Z" fill="url(#dxg)" />
      <path d="M32 24 L35 29 L32 32 L29 29 Z" fill="#111115" opacity=".55" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="text-[15px] font-bold tracking-tight">
      Drako<span className="brand-text">X</span>
    </span>
  );
}
