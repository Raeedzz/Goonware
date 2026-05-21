import { useMemo } from "react";
import { Block } from "./Block";
import type { Block as BlockType } from "./types";

interface Props {
  blocks: BlockType[];
  /**
   * Disable soft-wrap in shell closed blocks. Used by the narrow
   * right-panel secondary terminal so long lines pan via horizontal
   * scroll instead of wrapping into a hard-to-scan column. Agent
   * closed blocks already render no-wrap regardless of this flag.
   */
  noWrap?: boolean;
}

/**
 * Bottom-anchored scrollable column of closed blocks. Newest closed
 * block sits flush at the bottom; older blocks stack above with the
 * oldest at the top. The currently-running command lives in
 * `LiveBlock` rendered just below this list — by the time a block
 * shows up here, it's frozen.
 *
 * `flex-direction: column-reverse` does the bottom-anchoring for free
 * (browser stacks DOM source order from the bottom up), so we
 * iterate newest-first to put it at source[0] (= bottom of stack).
 * The scroll position naturally pins at the bottom: no scrollIntoView
 * jitter, no autoscroll race.
 */
export function BlockList({ blocks, noWrap = false }: Props) {
  const items = useMemo(() => {
    const out: { id: string; node: React.ReactNode }[] = [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      out.push({ id: block.id, node: <Block block={block} noWrap={noWrap} /> });
    }
    return out;
  }, [blocks, noWrap]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column-reverse",
        padding: "var(--space-2) 0",
      }}
    >
      {items.map((it) => (
        <div key={it.id}>{it.node}</div>
      ))}
    </div>
  );
}
