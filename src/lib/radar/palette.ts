// One colour per tracked person, used by the 3D view, the 2D view, trails and the target list so a person keeps
// the same colour everywhere (ID 01 green, ID 02 orange, ...).
// First two are the radar design's green and orange.
const TARGET_COLORS = ["#4ee75f", "#ffa714", "#38bdf8", "#f472b6", "#a78bfa", "#fb7185"] as const;

export function targetColor(targetId: number): string {
  const i = Math.max(0, Math.floor(targetId) - 1) % TARGET_COLORS.length;
  return TARGET_COLORS[i]!;
}

export function targetLabel(targetId: number): string {
  return String(targetId).padStart(2, "0");
}
