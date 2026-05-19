import type { CSSProperties } from "react";

/**
 * "Agent running" perimeter-wave — a 3×3 grid of small squares with a
 * muted-white crest that rotates clockwise around the outer ring,
 * looping indefinitely. The center cell sits at a calm mid-brightness
 * as a static anchor, so the loader always reads as "active" even
 * between crest passes.
 *
 * Visual contract:
 *   - Square slot sized via the `size` prop (defaults to 14). The
 *     grid takes `floor(size / 3) * 3`, so 18 ⇒ 18px, 16 ⇒ 15px, etc.
 *   - 8 perimeter cells form a closed clockwise cycle:
 *
 *         0 1 2          7 → 0 → 1
 *         3 4 5    →     ↑   *   ↓     (* = static center)
 *         6 7 8          6 ← 5 ← 4
 *
 *     The cycle closes on itself with every step being rook-adjacent,
 *     so the crest never has to jump diagonally — eliminating the
 *     visible "hop" the previous 9-cell snake had where it teleported
 *     from a corner to the center.
 *   - 5-stop muted palette in OKLCH, mirrored across 8 phases so the
 *     crest reads as a smooth rise-and-fall and 0% / 100% land on the
 *     same dark stop (seamless wrap).
 *
 * Motion:
 *   - Pure CSS keyframes. Perimeter cells carry `--gli-loader-snake-pos`
 *     (their 0..7 position along the cycle); `.gli-loader-cell` runs a
 *     1.2s walk through the palette with a negative `animation-delay`
 *     derived from that position, so each cell sits at its own phase
 *     and the wave reads as a single crest drifting around the ring.
 *   - The animation runs on the compositor thread, NOT the React
 *     main thread. Under load (20+ agents streaming, tab-switch
 *     storms, big diffs in flight) the loader stays visually
 *     continuous.
 *
 * Hardening:
 *   - No setInterval, no React state, no document.querySelector. Each
 *     instance is just nine spans with a class and a CSS variable.
 *   - prefers-reduced-motion freezes every cell at a calm mid-palette
 *     stop — the indicator still reads as "active", just motionless.
 *   - aria-hidden — decorative; the "running" state is conveyed by
 *     surrounding chrome (tab badge, hover card) with proper labels.
 *
 * Used in: sidebar worktree row, main-column tab strip, right-panel
 * secondary terminal indicator, worktree hover-card status, updater
 * toast. One implementation, one motion grammar.
 */

// Perimeter cycle: each entry is a 0..8 grid index, ordered clockwise
// around the ring starting from top-mid. Every step is rook-adjacent
// AND the last entry (top-left) is rook-adjacent to the first entry
// (top-mid), so the crest loops smoothly without any diagonal jump.
// Grid index 4 (center) is intentionally NOT on the cycle.
const PERIMETER_CYCLE = [1, 2, 5, 8, 7, 6, 3, 0];
const CENTER_GRID_INDEX = 4;

// SNAKE_POS_BY_GRID[i] = "where in the perimeter cycle does grid cell
// i sit?" — null for the center (it gets a different class).
const SNAKE_POS_BY_GRID: (number | null)[] = new Array(9).fill(null);
PERIMETER_CYCLE.forEach((gridIdx, snakePos) => {
  SNAKE_POS_BY_GRID[gridIdx] = snakePos;
});

export function Loader({
  size = 14,
}: {
  /** Pixel size of the square slot. Default 14. */
  size?: number;
}) {
  // Squares are integer-sized so they line up pixel-perfect on the
  // grid (CSS subpixel rounding can leave hairline seams between cells
  // otherwise). Minimum 2px so the wave is still visible at small sizes.
  const squareWidth = Math.max(2, Math.floor(size / 3));
  const gridWidth = squareWidth * 3;

  return (
    <span
      style={{
        display: "inline-grid",
        gridTemplateColumns: `repeat(3, ${squareWidth}px)`,
        gridTemplateRows: `repeat(3, ${squareWidth}px)`,
        width: gridWidth,
        height: gridWidth,
        flexShrink: 0,
        // Dark base under the perimeter cells. The cells themselves
        // are a fixed bright color whose opacity animates, so when a
        // cell dims it fades into this base — giving us a smooth,
        // GPU-accelerated wave that's not vulnerable to main-thread
        // paint stalls the way `background-color` interpolation is.
        backgroundColor: "oklch(36% 0.003 250)",
      }}
      aria-hidden
    >
      {Array.from({ length: 9 }).map((_, gridIndex) => {
        if (gridIndex === CENTER_GRID_INDEX) {
          return <span key={gridIndex} className="gli-loader-cell-center" />;
        }
        const snakePos = SNAKE_POS_BY_GRID[gridIndex];
        return (
          <span
            key={gridIndex}
            className="gli-loader-cell"
            style={
              {
                "--gli-loader-snake-pos": snakePos,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}
