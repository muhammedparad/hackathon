// Body silhouettes from the radar design: a standing person (still) and a walking one (moving).
// Drawn with the feet at the origin, about 77 units tall, so a parent scales them to the projected height.

export const FIGURE_HEIGHT = 77;

export function StandingFigure({ c }: { c: string }) {
  return (
    <g fill={c} fillOpacity={0.85} stroke={c} strokeWidth={1}>
      <circle cx={0} cy={-70} r={7} />
      <path d="M-4,-62 h8 l2,3 h5 q4,1 4,5 l1,24 q0,3 -3,3 l-1,-22 h-1 l0,28 l-1,34 h-6 l-1,-30 l-1,30 h-6 l-1,-34 l0,-28 h-1 l-1,22 q-3,0 -3,-3 l1,-24 q0,-4 4,-5 h5 z" />
    </g>
  );
}

export function WalkingFigure({ c }: { c: string }) {
  return (
    <g fill={c} fillOpacity={0.85} stroke={c} strokeWidth={1}>
      <circle cx={2} cy={-68} r={6.5} />
      <path d="M-3,-60 q6,-2 10,1 q3,3 3,8 l3,14 l5,8 l-3,2 l-6,-8 l-2,-8 l0,14 l6,14 l4,16 l5,2 l-1,3 h-9 l-4,-18 l-7,-12 l-4,12 l-9,16 l-4,-2 l8,-18 l3,-14 l0,-14 l-4,10 l-3,8 l-3,-1 l3,-10 l3,-14 q1,-6 4,-8 z" />
    </g>
  );
}
