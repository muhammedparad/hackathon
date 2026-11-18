import { createFileRoute } from "@tanstack/react-router";
import radarRoom from "@/assets/radar_room.png.asset.json";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "3D Radar (Perspective)" },
      { name: "description", content: "Live 3D radar view showing people detected in a room." },
      { property: "og:title", content: "3D Radar (Perspective)" },
      { property: "og:description", content: "Live 3D radar view showing people detected in a room." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

const L = "var(--radar-line)";
const F = "var(--radar-furniture)";
const FL = "var(--radar-furniture-light)";
const G = "var(--radar-green)";
const O = "var(--radar-orange)";
const T = "var(--radar-text)";

function StandingHuman({ c }: { c: string }) {
  // front-facing standing person, origin at feet center
  return (
    <g fill={c} fillOpacity={0.85} stroke={c} strokeWidth={1} filter="url(#glow)">
      <circle cx={0} cy={-70} r={7} />
      <path d="M-4,-62 h8 l2,3 h5 q4,1 4,5 l1,24 q0,3 -3,3 l-1,-22 h-1 l0,28 l-1,34 h-6 l-1,-30 l-1,30 h-6 l-1,-34 l0,-28 h-1 l-1,22 q-3,0 -3,-3 l1,-24 q0,-4 4,-5 h5 z" />
    </g>
  );
}

function WalkingHuman({ c }: { c: string }) {
  return (
    <g fill={c} fillOpacity={0.85} stroke={c} strokeWidth={1} filter="url(#glow)">
      <circle cx={2} cy={-68} r={6.5} />
      <path d="M-3,-60 q6,-2 10,1 q3,3 3,8 l3,14 l5,8 l-3,2 l-6,-8 l-2,-8 l0,14 l6,14 l4,16 l5,2 l-1,3 h-9 l-4,-18 l-7,-12 l-4,12 l-9,16 l-4,-2 l8,-18 l3,-14 l0,-14 l-4,10 l-3,8 l-3,-1 l3,-10 l3,-14 q1,-6 4,-8 z" />
    </g>
  );
}

function Tag({ x, y, id, d, c }: { x: number; y: number; id: string; d: string; c: string }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect width={50} height={32} rx={5} fill="var(--radar-panel)" stroke={L} strokeOpacity={0.3} />
      <text x={6} y={14} fontSize={11} fontWeight={700} fill={T}>ID: {id}</text>
      <text x={6} y={26} fontSize={9} fill={c}>({d})</text>
    </g>
  );
}

function Bracket({ x, y, w, h, c }: { x: number; y: number; w: number; h: number; c: string }) {
  const s = 7;
  return (
    <g stroke={c} strokeWidth={1.5} fill="none">
      <path d={`M${x},${y + s}V${y}H${x + s}M${x + w - s},${y}H${x + w}V${y + s}M${x + w},${y + h - s}V${y + h}H${x + w - s}M${x + s},${y + h}H${x}V${y + h - s}`} />
    </g>
  );
}

function Radar() {
  const rings = [0.5, 1, 1.5, 2, 2.5, 3];
  return (
    <svg viewBox="0 0 440 390" className="w-full">
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <radialGradient id="cone" cx="50%" cy="0%" r="100%">
          <stop offset="0%" stopColor="var(--radar-glow)" stopOpacity={0.55} />
          <stop offset="100%" stopColor="var(--radar-glow)" stopOpacity={0} />
        </radialGradient>
        <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={L} stopOpacity={0.04} />
          <stop offset="100%" stopColor={L} stopOpacity={0.14} />
        </linearGradient>
      </defs>

      {/* walls + floor */}
      <path d="M30,120 L220,20 L220,140 L30,250 Z" fill="url(#wall)" />
      <path d="M220,20 L410,120 L410,250 L220,140 Z" fill="url(#wall)" />
      <path d="M30,250 L220,140 L410,250 L220,375 Z" fill={L} fillOpacity={0.08} />
      <g stroke={L} strokeWidth={1.6} fill="none" filter="url(#glow)">
        <path d="M30,120 L220,20 L410,120 L410,250 L220,375 L30,250 Z" />
        <path d="M220,20 V140 M30,250 L220,140 L410,250" strokeOpacity={0.6} />
      </g>

      {/* window + curtains */}
      <g>
        <path d="M70,110 L130,78 L130,165 L70,198 Z" fill={L} fillOpacity={0.12} stroke={FL} />
        <path d="M100,94 V182 M70,150 L130,118" stroke={FL} />
        {[58, 64, 70].map((x) => <path key={x} d={`M${x},${118 - (x - 58) * 0.5} v95`} stroke={FL} strokeWidth={4} opacity={0.7} />)}
        {[128, 134, 140].map((x) => <path key={x} d={`M${x},${80 - (x - 128) * 0.5} v95`} stroke={FL} strokeWidth={4} opacity={0.7} />)}
      </g>

      {/* plant */}
      <path d="M48,250 h18 l-2,16 h-14 z" fill={FL} />
      {[-30, -10, 10, 30, -50, 50].map((a) => (
        <ellipse key={a} cx={57} cy={232} rx={4} ry={16} fill="oklch(0.55 0.12 150)" transform={`rotate(${a} 57 248)`} />
      ))}

      {/* nightstand + lamp */}
      <path d="M150,175 l25,-12 l20,10 v22 l-25,12 l-20,-10 z" fill={F} stroke={FL} />
      <path d="M165,150 h14 l3,14 h-20 z" fill="oklch(0.9 0.1 85)" filter="url(#glow)" />
      <path d="M172,164 v8" stroke={FL} strokeWidth={2} />

      {/* bed */}
      <path d="M80,205 L160,165 L160,200 L80,245 Z" fill={F} stroke={FL} />
      <path d="M85,240 L160,198 L225,235 L150,278 Z" fill={FL} stroke={FL} />
      <path d="M150,278 L225,235 L225,250 L150,293 Z" fill={F} />
      <path d="M85,240 L150,278 L150,293 L85,255 Z" fill={F} />
      <path d="M95,228 l25,-13 l15,8 l-25,13 z M120,215 l25,-13 l15,8 l-25,13 z" fill="var(--radar-text)" fillOpacity={0.7} />
      <path d="M110,255 L180,215 L225,240 L150,282 Z" fill={L} fillOpacity={0.25} />

      {/* door */}
      <path d="M310,100 L345,118 L345,215 L310,196 Z" fill={F} fillOpacity={0.4} stroke={FL} strokeWidth={2} />
      <circle cx={338} cy={165} r={2} fill={FL} />

      {/* wardrobe */}
      <path d="M350,135 L395,160 L395,255 L350,230 Z" fill={F} stroke={FL} />
      <path d="M350,135 L365,127 L405,150 L395,160 Z" fill={FL} />
      <path d="M372,147 V242" stroke={FL} />

      {/* radar rings */}
      <g fill="none" stroke={L} strokeOpacity={0.35}>
        {rings.map((r, i) => (
          <ellipse key={r} cx={230} cy={200} rx={30 + i * 28} ry={(30 + i * 28) * 0.55} />
        ))}
      </g>
      {/* cone */}
      <path d="M242,82 L120,240 Q240,300 360,240 Z" fill="url(#cone)" opacity={0.7} />
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={i} d={`M${242 - 18 - i * 16},${110 + i * 22} Q242,${125 + i * 28} ${242 + 18 + i * 16},${110 + i * 22}`} stroke="var(--radar-glow)" strokeOpacity={0.5} fill="none" />
      ))}
      {rings.map((r, i) => (
        <text key={r} x={252} y={252 + i * 16} fontSize={9} fill={T}>{r.toFixed(1)} m</text>
      ))}

      {/* sensor */}
      <g filter="url(#glow)">
        <path d="M230,68 l12,-6 l12,6 v8 l-12,6 l-12,-6 z" fill="var(--radar-text)" />
        <circle cx={242} cy={76} r={3} fill="var(--radar-glow)" />
      </g>

      {/* humans */}
      <ellipse cx={172} cy={280} rx={20} ry={7} fill={G} opacity={0.3} />
      <Bracket x={150} y={198} w={44} h={88} c={G} />
      <g transform="translate(172,280)"><StandingHuman c={G} /></g>
      <Tag x={182} y={198} id="01" d="1.2 m" c={G} />

      <ellipse cx={328} cy={272} rx={18} ry={6} fill={O} opacity={0.3} />
      <Bracket x={310} y={196} w={40} h={82} c={O} />
      <g transform="translate(328,272)"><WalkingHuman c={O} /></g>
      <Tag x={352} y={202} id="02" d="2.6 m" c={O} />
    </svg>
  );
}

function Index() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <img src={radarRoom.url} alt="3D radar view of a bedroom with two detected people" className="w-full max-w-md rounded-2xl" />
    </main>
  );
}
