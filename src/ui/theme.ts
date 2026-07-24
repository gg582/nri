/**
 * Seoulism palette (from ~/seoulism.vim/colors/seoulism.vim) mapped onto
 * nri UI semantics. The vim scheme's own meaning mapping is preserved:
 * comments recede (trace log), statements control (routing/edges),
 * types are bright (structure), emerald is additive success, etc.
 */
export const palette = {
  // canvas
  bg: "#111116", // pine ink black
  bgAlt: "#1a1a22",
  bgSel: "#2f4fa3",

  // text hierarchy
  fg: "#b6b5a8",
  fgSub: "#d7d6d2",
  fgBright: "#efeeea", // Type — structure, node ids

  // accents
  vermilion: "#e05a55", // Statement — control flow, routing, edges
  jade: "#3aa39a", // Special — accents
  emerald: "#3abf86", // GitAdd — success, coverage met
  ochre: "#e5c15a", // String/Number — values, warnings
  royalBlue: "#3f6bd9",
  mutedBlue: "#7f85ac", // Comment — receded trace log
  charcoal: "#5f6770", // Delimiter — dim separators
  gold: "#f0d487", // Question — HITL prompts
  sky: "#6f8ee6", // Constant — provider/model info
  error: "#e77e79", // Error — pre-flight violations, failures

  // graph depth gradient endpoints (user-specified)
  depthShallow: "#A8B858",
  depthDeep: "#D88A9A",
} as const;

/** Semantic aliases used by the UI components. */
export const theme = {
  trace: palette.mutedBlue,
  structure: palette.fgBright,
  control: palette.vermilion,
  success: palette.emerald,
  value: palette.ochre,
  info: palette.sky,
  prompt: palette.gold,
  error: palette.error,
  dim: palette.charcoal,
  accent: palette.jade,
  text: palette.fg,
} as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Depth color: 0 (shallow) -> depthShallow, 1 (deepest) -> depthDeep.
 * `t` is clamped to [0, 1].
 */
export function depthColor(t: number): string {
  const a = hexToRgb(palette.depthShallow);
  const b = hexToRgb(palette.depthDeep);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex([
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ]);
}
