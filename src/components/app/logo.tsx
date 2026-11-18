export function Logo({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 36" className={className} aria-hidden fill="none">
      <defs>
        <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2563EB" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
      {/* Outer shield container */}
      <rect width="36" height="36" rx="10" fill="url(#shieldGrad)" />
      {/* Radar waves / Silver Shield emblem */}
      <path
        d="M10 24C12 21 15 19 18 19C21 19 24 21 26 24"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.95"
      />
      <path
        d="M13 19C14.5 17 16.2 16 18 16C19.8 16 21.5 17 23 19"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.75"
      />
      <path
        d="M15.5 15C16.3 14 17.1 13.5 18 13.5C18.9 13.5 19.7 14 20.5 15"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.5"
      />
      <circle cx="18" cy="10.5" r="2" fill="white" />
    </svg>
  );
}
