/** Decorative radar scene used on the sign-in screen. Pure SVG, no data. */
export function RadarHero({ className }: { className?: string }) {
  const cx = 170,
    cy = 40,
    R = 200;
  const s = Math.sin(Math.PI / 3),
    c = Math.cos(Math.PI / 3);
  const fov = `M ${cx} ${cy} L ${cx - s * R} ${cy + c * R} A ${R} ${R} 0 0 0 ${cx + s * R} ${cy + c * R} Z`;
  const sw = (7 * Math.PI) / 180;
  const wedge = `M 0 0 L ${-Math.sin(sw) * R} ${Math.cos(sw) * R} A ${R} ${R} 0 0 0 ${Math.sin(sw) * R} ${Math.cos(sw) * R} Z`;
  return (
    <svg
      viewBox="0 0 340 280"
      className={className}
      role="img"
      aria-label="Illustration of a radar sweeping a room and tracking two people"
    >
      <defs>
        <clipPath id="hero-room">
          <rect x={28} y={40} width={284} height={212} rx={8} />
        </clipPath>
        <radialGradient id="hero-fov" cx={cx} cy={cy} r={R} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
        </radialGradient>
        <radialGradient id="hero-sweep" cx={0} cy={0} r={R} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.45} />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
        </radialGradient>
        <linearGradient id="hero-floor" x1={0} y1={0} x2={0} y2={1}>
          <stop offset="0%" stopColor="var(--radar-floor-2)" />
          <stop offset="100%" stopColor="var(--radar-floor)" />
        </linearGradient>
      </defs>

      <rect x={28} y={40} width={284} height={212} rx={8} fill="url(#hero-floor)" />
      <g clipPath="url(#hero-room)" className="stroke-grid" strokeWidth={1}>
        {Array.from({ length: 8 }, (_, i) => (
          <line key={`v${i}`} x1={28 + i * 40} y1={40} x2={28 + i * 40} y2={252} />
        ))}
        {Array.from({ length: 6 }, (_, i) => (
          <line key={`h${i}`} x1={28} y1={40 + i * 40} x2={312} y2={40 + i * 40} />
        ))}
      </g>
      <g clipPath="url(#hero-room)">
        <path d={fov} fill="url(#hero-fov)" />
        <g className="stroke-radar-range" fill="none" strokeWidth={1} strokeDasharray="3 5">
          {[50, 100, 150, 200].map((r) => (
            <circle key={r} cx={cx} cy={cy} r={r} />
          ))}
        </g>
        <g transform={`translate(${cx} ${cy})`}>
          <path d={wedge} fill="url(#hero-sweep)">
            <animateTransform
              attributeName="transform"
              type="rotate"
              values="-60;60;-60"
              dur="5.5s"
              repeatCount="indefinite"
            />
          </path>
        </g>
        <g>
          <circle r={7} className="fill-chart-1" opacity={0.9}>
            <animate attributeName="r" values="6;8;6" dur="2.2s" repeatCount="indefinite" />
          </circle>
          <animateMotion
            dur="9s"
            repeatCount="indefinite"
            path="M 96 118 C 150 200, 210 96, 252 186 C 210 232, 120 210, 96 118"
          />
        </g>
        <g>
          <circle r={6} className="fill-chart-2" opacity={0.9} />
          <animateMotion
            dur="12s"
            repeatCount="indefinite"
            path="M 246 96 C 200 170, 130 150, 88 214 C 140 240, 220 200, 246 96"
          />
        </g>
      </g>
      <path
        d={fov}
        className="fill-none stroke-primary/40"
        strokeWidth={1}
        strokeDasharray="4 4"
        clipPath="url(#hero-room)"
      />
      <rect
        x={28}
        y={40}
        width={284}
        height={212}
        rx={8}
        className="fill-none stroke-radar-wall"
        strokeWidth={2}
      />
      <g transform={`translate(${cx} ${cy})`}>
        <rect x={-16} y={-7} width={32} height={13} rx={3} className="fill-radar-wall" />
        <circle r={3.5} className="fill-primary">
          <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  );
}
