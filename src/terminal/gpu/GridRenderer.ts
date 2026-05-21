/**
 * WebGPU grid renderer. Draws a terminal frame as instanced quads
 * sampling a glyph atlas. One draw call per frame for the visible
 * cells; uniforms carry cell size + canvas resolution.
 *
 * Current scope (post-Phase-3a):
 *   - Dynamic Unicode atlas (rasterize-on-miss; see Atlas.ts)
 *   - Bold / italic via atlas variants; dim via fragment alpha
 *   - Underline + strikethrough rendered in the fragment shader
 *     from per-cell flags packed into the instance data
 *   - Inverse swap of fg/bg
 *   - Cursor (block style) overlaid at the requested cell, with row
 *     coordinates honored in both whole-frame and inline windows
 *   - One draw call per frame; redundant rebuilds short-circuited by
 *     seq dedupe
 *
 * Not yet:
 *   - Cursor styles other than block (beam / underline)
 *
 * Device-loss recovery: `createGridRenderer` accepts an `onDeviceLost`
 * callback that fires when the underlying GPUDevice is lost (system
 * sleep/wake, driver reset, GPU crash). The caller is expected to
 * destroy() the dead renderer and bootstrap a new one. CanvasGrid
 * does this transparently — the user sees a single frame of black
 * during the swap and the agent continues painting from the next seq.
 */

import type { DirtyRow, RenderFrame, Span } from "../types";
import { createAtlas, type Atlas, type GlyphStyle } from "./Atlas";

/**
 * Decoupled input the renderer actually consumes. Lets callers pass
 * either a whole frame (full-pane alt-screen) or a windowed subset
 * (inline LiveBlock body) without reshaping the frame itself.
 */
export interface RenderInput {
  /** Rows to draw, in display order (top to bottom). */
  rows: DirtyRow[];
  /** Total column count in the grid (used for cursor clamping). */
  cols: number;
  /** Monotonic id for dedupe. Skip render if unchanged since last. */
  seq: number;
  /**
   * Optional cursor position in cell coords (row index relative to
   * `rows[0]`, not the original grid). Pass null/undefined to hide.
   */
  cursor?: { row: number; col: number; visible: boolean } | null;
  /**
   * Currently-selected cell range, half-open by (row, col) ordered
   * pair. The renderer marks any cell inside the range with the
   * SELECTED flag so the fragment shader can paint an accent overlay.
   * Coordinates are window-relative — same space as `cursor.row/col`.
   * Null/undefined when nothing is selected.
   *
   * `start` is the anchor (where the user pressed mouse-down) and
   * `end` is the live mouse position. The renderer canonicalises
   * order internally so either direction works.
   */
  selection?: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
}

/**
 * Cell size in CSS pixels — exposed so hit-test logic in CanvasGrid
 * can convert mouse coordinates to cell (row, col) without
 * duplicating the atlas measurement math.
 */
export interface CellSize {
  widthCss: number;
  heightCss: number;
}

const SHADER = /* wgsl */ `
// All projection math runs in PHYSICAL device pixels — never CSS
// pixels. Going through CSS introduces sub-pixel positioning bugs:
// when the canvas's CSS width isn't a clean multiple of
// 1/devicePixelRatio, cell edges land on fractional physical pixels
// and bilinear glyph sampling smears them across two device pixels
// each, which reads as low-resolution fuzz. With physical-pixel
// projection, cell N's left edge is exactly N * cellWidthPx and the
// viewport is exactly canvas.width physical pixels — guaranteed
// integer alignment, crisp glyphs.
struct Uniforms {
  cellSize: vec2<f32>,
  resolution: vec2<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

// Bitmask packed into instance.flags:
//   bit 0 = underline
//   bit 1 = strikethrough
//   bit 2 = is-cursor (suppresses underline / strikethrough overlays)
//   bit 3 = selected (paints an accent overlay over the cell)
const FLAG_UNDERLINE: u32 = 1u;
const FLAG_STRIKE: u32 = 2u;
const FLAG_CURSOR: u32 = 4u;
const FLAG_SELECTED: u32 = 8u;

struct VertexInput {
  @location(0) quadPos: vec2<f32>,
  @location(1) cellPos: vec2<f32>,
  @location(2) atlasUV: vec2<f32>,
  @location(3) atlasSize: vec2<f32>,
  @location(4) fgColor: vec4<f32>,
  @location(5) bgColor: vec4<f32>,
  @location(6) flags: u32,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) fg: vec4<f32>,
  @location(2) bg: vec4<f32>,
  @location(3) cellLocal: vec2<f32>,
  @location(4) @interpolate(flat) flags: u32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let pixelPos = (in.cellPos + in.quadPos) * u.cellSize;
  let clip = vec4<f32>(
    (pixelPos.x / u.resolution.x) * 2.0 - 1.0,
    -((pixelPos.y / u.resolution.y) * 2.0 - 1.0),
    0.0,
    1.0
  );
  let uv = in.atlasUV + in.quadPos * in.atlasSize;
  var out: VertexOutput;
  out.position = clip;
  out.uv = uv;
  out.fg = in.fgColor;
  out.bg = in.bgColor;
  // Local cell coords (0..1) — used to draw underline / strike bands
  // without needing a separate pipeline pass.
  out.cellLocal = in.quadPos;
  out.flags = in.flags;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Atlas glyphs were rasterized as white-on-transparent, so the alpha
  // channel is the coverage mask. We tint the BACKGROUND first (so a
  // selection overlay can't bleed into the glyph) and only then
  // composite the glyph on top via coverage. This is what keeps an
  // agent's painted-cursor glyph crisp inside a selection range —
  // earlier passes mixed the selection accent into the final color
  // and the cursor glyph faded to a near-invisible smudge.
  let coverage = textureSample(atlasTex, atlasSampler, in.uv).a;
  let isCursor = (in.flags & FLAG_CURSOR) != 0u;

  var bgColor = in.bg.rgb;
  var bgAlpha = in.bg.a;
  if ((in.flags & FLAG_SELECTED) != 0u && !isCursor) {
    // Soft steel-blue selection accent. Mixed into the BG only — the
    // glyph composites on top at full foreground color, so text in a
    // selected cell stays at the same contrast as elsewhere.
    let selBg = vec3<f32>(0.30, 0.46, 0.64);
    bgColor = mix(bgColor, selBg, 0.55);
    bgAlpha = max(bgAlpha, 0.85);
  }

  var rgb = mix(bgColor, in.fg.rgb, coverage);
  var alpha = max(bgAlpha, in.fg.a * coverage);

  // Underline + strikethrough overlays. We paint a thin band in the
  // foreground color when the corresponding flag is set, drawn over
  // both the glyph and the background. Skipped for the cursor sprite
  // (the cursor's own bg is solid; layering a stripe on top would
  // create a notch).
  if (!isCursor) {
    if ((in.flags & FLAG_UNDERLINE) != 0u) {
      let v = in.cellLocal.y;
      if (v > 0.86 && v < 0.95) {
        rgb = in.fg.rgb;
        alpha = max(alpha, in.fg.a);
      }
    }
    if ((in.flags & FLAG_STRIKE) != 0u) {
      let v = in.cellLocal.y;
      if (v > 0.46 && v < 0.54) {
        rgb = in.fg.rgb;
        alpha = max(alpha, in.fg.a);
      }
    }
  }
  return vec4<f32>(rgb, alpha);
}
`;

/**
 * Instance attribute layout in bytes:
 *   cellPos      f32x2  (8)
 *   atlasUV      f32x2  (8)
 *   atlasSize    f32x2  (8)
 *   fgColor      f32x4  (16)
 *   bgColor      f32x4  (16)
 *   flags        u32    (4)
 *   padding      u32x3  (12, padding to 72-byte alignment for u32x4 row)
 *
 * Total = 72 bytes per instance. The 12-byte tail keeps the next
 * instance's `cellPos` aligned to the same offset for every slot —
 * WebGPU is happy as long as `arrayStride` is a multiple of 4 and the
 * attributes don't straddle a 16-byte boundary in a way the validation
 * layer rejects. 72 satisfies that without playing alignment games.
 */
const BYTES_PER_CELL = 72;

const FLAG_UNDERLINE = 1;
const FLAG_STRIKE = 2;
const FLAG_CURSOR = 4;
const FLAG_SELECTED = 8;

/**
 * Number of consecutive successful draws between forced
 * `context.configure(...)` heartbeats.
 *
 * Why a heartbeat exists: WKWebView can silently release the canvas's
 * GPU surface mid-session — not just on hide/show — without firing
 * `device.lost` or any ResizeObserver tick. `getCurrentTexture()` then
 * returns a texture that draws nowhere (or throws on the next call);
 * the user reports it as "the terminal went black WHILE the agent was
 * running, I hadn't switched tabs." The existing visibility-restore +
 * resize-time reconfigure can't help here because nothing on the
 * wrapper / visibility side actually changed.
 *
 * The heartbeat is the load-bearing safety net for that class. Every
 * HEARTBEAT_FRAMES successful paints, the next `draw()` pre-emptively
 * reconfigures the swapchain. Configure on a healthy surface is
 * idempotent (the browser short-circuits when the descriptor is
 * unchanged), so the ongoing cost is negligible. The cost of NOT
 * having it is "agent shell stuck on black until the user switches
 * tabs back and forth," which is the user-reported symptom this guards.
 *
 * Threshold choice: 60 frames ≈ 1 second at the renderer's 60Hz
 * cadence. A surface-death window of up to 1 second of black-out before
 * auto-recovery. Smaller than the user's perceptual stuck threshold
 * (which feels like several seconds) and big enough that the
 * reconfigure cost stays sub-percent of frame time.
 */
const HEARTBEAT_FRAMES = 60;

export class GridRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  /**
   * Preserved so `reconfigure()` can re-call `context.configure(...)`
   * without re-querying the adapter. Critical for the visibility-
   * restore path — see the doc on `reconfigure()` below.
   */
  private format: GPUTextureFormat;
  private atlas: Atlas;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;
  private uniformBuffer: GPUBuffer;
  private quadBuffer: GPUBuffer;
  private instanceBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  /** Reused scratch buffer to avoid GC on every render. */
  private scratch = new ArrayBuffer(0);
  private scratchF32 = new Float32Array(0);
  private scratchU32 = new Uint32Array(0);
  /** Last frame's seq — short-circuits redundant rebuilds. */
  private lastSeq = -1;
  /**
   * Set to true once `device.lost` resolves. All public methods become
   * no-ops past that point — calling into a dead device throws WebGPU
   * validation errors that the console can't recover from, and the
   * caller is responsible for swapping in a fresh renderer anyway.
   */
  private lost = false;
  /**
   * Set when `getCurrentTexture()` throws inside `draw()`. The very
   * next render call calls `reconfigure()` before attempting the draw
   * again. Resets to false after a successful draw.
   *
   * Also set by `markHidden()` so the next `resize()` after a
   * `display: none → flex` flip takes the full configure path even
   * when the wrapper dimensions didn't change. Without this signal
   * the resize() fast path (dimensions unchanged → no-op) would
   * skip the reconfigure and the user would land on a dead
   * swapchain.
   *
   * Why: WKWebView can release the canvas's GPU surface during a
   * `display: none` window without firing `device.lost` — the
   * device is fine, but the swapchain is dead. The next paint
   * after the canvas becomes visible again then throws inside
   * `getCurrentTexture()`. Catching + reconfiguring lets the
   * SECOND render attempt succeed without surfacing the error to
   * the user.
   */
  private needsReconfigure = false;
  /**
   * Last physical canvas dimensions we resized to. Used by `resize()`
   * to skip the canvas.width/height + configure() driver round-trip
   * when the wrapper fires a ResizeObserver tick with the same size
   * (the common case for keepalive layer visibility flips — the
   * absolute-positioned wrapper has the same inset:0 rect before and
   * after the display flip).
   *
   * Was the dominant contributor to "switching cells is super slow"
   * once a project accumulated more than a couple of agent shells —
   * every show-hide cycle paid a configure() driver call per cell
   * just to land on identical dimensions.
   */
  private lastPhysWidth = 0;
  private lastPhysHeight = 0;
  /**
   * Successful `draw()` paints since the last `reconfigure()`. Drives
   * the heartbeat — see `HEARTBEAT_FRAMES` above for the full WHY.
   *
   * Only incremented on the post-submit path so a skipped frame
   * (getCurrentTexture failed twice → bail) does NOT count toward the
   * threshold. Otherwise a stuck-dead surface would trip the
   * heartbeat almost immediately and the reconfigure would land too
   * often during real failure conditions (where the visibility-
   * restore + draw-retry paths are already trying to recover).
   */
  private framesSinceReconfigure = 0;

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    atlas: Atlas,
  ) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.atlas = atlas;

    const quadVerts = new Float32Array([
      0, 0, 1, 0, 0, 1,
      1, 0, 1, 1, 0, 1,
    ]);
    this.quadBuffer = device.createBuffer({
      size: quadVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.quadBuffer, 0, quadVerts);

    this.uniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({ code: SHADER });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: atlas.view },
        { binding: 2, resource: atlas.sampler },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 8,
            stepMode: "vertex",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
            ],
          },
          {
            arrayStride: BYTES_PER_CELL,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x2" },
              { shaderLocation: 2, offset: 8, format: "float32x2" },
              { shaderLocation: 3, offset: 16, format: "float32x2" },
              { shaderLocation: 4, offset: 24, format: "float32x4" },
              { shaderLocation: 5, offset: 40, format: "float32x4" },
              { shaderLocation: 6, offset: 56, format: "uint32" },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  /**
   * Re-call `context.configure(...)` so WKWebView re-acquires the
   * canvas's GPU swapchain. This is the LOAD-BEARING fix for the
   * black-screen-on-tab-switch class of bugs.
   *
   * Why this exists: `GPUCanvasContext.configure` was historically
   * called once at bootstrap. macOS WKWebView is known to release
   * the underlying GPU surface for canvases hosted under `display:
   * none` views — without firing `device.lost`. From WebGPU's
   * perspective the device is fine, but the swapchain is dead.
   * `getCurrentTexture()` then returns a texture that draws nowhere
   * and the user sees `var(--surface-0)` (effectively black) until
   * the next call to `context.configure(...)`.
   *
   * Calling this on every hidden→visible transition forces the
   * swapchain to be re-acquired against the live surface. Idempotent
   * on a healthy surface (configure() on an already-configured
   * context updates the descriptor without re-allocating), so it's
   * safe to call defensively whenever in doubt.
   *
   * Also resets `lastSeq` so the next render bypasses dedupe — the
   * new swapchain's first frame must paint or the user sees the
   * cleared-black starting buffer.
   */
  reconfigure(): void {
    if (this.lost) return;
    try {
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });
      this.needsReconfigure = false;
      this.lastSeq = -1;
      // Heartbeat counter resets every time we successfully
      // re-acquire the swapchain — including the resize-time path,
      // which routes through here implicitly via the configure call.
      // Resetting here (instead of at draw time) means a successful
      // reconfigure ALWAYS restarts the heartbeat clock, even if the
      // caller routed through `resize()` rather than this method
      // directly.
      this.framesSinceReconfigure = 0;
    } catch (err) {
      // configure() can throw if the canvas is detached from the DOM
      // or the context is already in a bad state. We can't do
      // anything useful here — defer to the bootstrap rebuild path
      // (CanvasGrid's epoch bump on persistent failure).
      // eslint-disable-next-line no-console
      console.warn("[GridRenderer] reconfigure failed:", err);
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.lost) return;
    // Compute physical (device) pixels from the CSS box.
    //
    // Width: FLOOR so the canvas's CSS width is never larger than
    // what the wrapper asked for. Ceil + fractional cssWidth (common
    // at 1.5/2.5/3 DPRs, or any non-integer wrapper width that flex
    // layout produces) makes the canvas overflow its parent by up to
    // one CSS pixel — visible as "text spilling behind the right
    // sidebar" when the panel is docked.
    //
    // Height: keep CEIL. Flooring leaves the buffer one physical
    // pixel short of the content the atlas wants to draw when
    // DPR × CSS height isn't an integer, which clips the bottom of
    // the last row. There's no neighbour below the canvas to compete
    // with, so an extra pixel of vertical headroom is invisible.
    const physWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const physHeight = Math.max(1, Math.ceil(cssHeight * dpr));
    // Fast path: dimensions unchanged AND we have no reason to
    // believe the surface is dead. ResizeObserver fires once per
    // frame, and a keepalive-layer display:none → flex flip will
    // re-emit the SAME contentRect we resized to before the hide
    // (the absolute-positioned wrapper's box geometry doesn't
    // change with `display`). Doing the canvas.width/height
    // assignments + a `context.configure()` driver round-trip
    // here on every such tick is what the user feels as "switching
    // cells is super slow" once a project has more than a handful
    // of agent shells in the keepalive layer.
    //
    // `needsReconfigure` is the surface-may-be-dead signal — it's
    // set by `markHidden()` on visibility-flip-to-hidden and by
    // the `draw()` retry path. When it's TRUE we MUST take the
    // slow path (canvas reset + configure) even when dimensions
    // match, because the WKWebView swapchain might have been
    // silently released while we were `display: none`. Skipping
    // the configure here would land the user on a dead surface =
    // back to the original "switch tab → black pane" bug.
    if (
      physWidth === this.lastPhysWidth &&
      physHeight === this.lastPhysHeight &&
      !this.needsReconfigure
    ) {
      return;
    }
    // Pin the canvas's CSS size to physWidth/dpr (instead of letting
    // the layout pick a fractional CSS size). This avoids browser
    // resampling between the pixel buffer and the displayed CSS box
    // — the dominant source of "fuzzy text" in WebGPU terminals.
    // Ceiling here may push the canvas CSS size to be at most one
    // device pixel wider/taller than the wrapper asked for; the
    // extra row of pixels is unfilled (cleared to background) and
    // invisible.
    const canvas = this.context.canvas as HTMLCanvasElement;
    canvas.width = physWidth;
    canvas.height = physHeight;
    canvas.style.width = `${physWidth / dpr}px`;
    canvas.style.height = `${physHeight / dpr}px`;
    // Re-acquire the swapchain against the freshly-sized canvas.
    // Without this, a resize that follows a `display: none` hide can
    // succeed in CSS but still hit a dead GPU surface on the next
    // getCurrentTexture() — exactly the "switch tabs → black pane"
    // user report. configure() is idempotent on a healthy surface,
    // so calling it here is cheap insurance — and the fast-path
    // short-circuit above keeps it from running on no-op resizes.
    try {
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });
      this.needsReconfigure = false;
      // Reset the heartbeat clock on every successful resize-time
      // reconfigure. Otherwise a busy ResizeObserver burst (e.g. an
      // agent streaming output that grows scrollback row by row)
      // would each immediately tally toward HEARTBEAT_FRAMES and we'd
      // double-reconfigure every second of agent output.
      this.framesSinceReconfigure = 0;
    } catch (err) {
      // Same fallback as in `reconfigure()` — if configure() throws
      // we can't usefully recover from inside resize; flag for the
      // next draw to retry.
      this.needsReconfigure = true;
      // eslint-disable-next-line no-console
      console.warn("[GridRenderer] resize-time configure failed:", err);
    }
    // Remember the new dimensions so the next no-op resize tick
    // takes the fast path above.
    this.lastPhysWidth = physWidth;
    this.lastPhysHeight = physHeight;
    // Force the next render to repaint regardless of seq dedupe.
    this.lastSeq = -1;
  }

  /**
   * Signal that the canvas is about to be hidden (parent went
   * `display: none`). Sets `needsReconfigure` so the next `resize()`
   * — which typically fires the moment we come back visible and
   * ResizeObserver re-emits the same contentRect — does NOT take
   * the dimensions-unchanged fast path. The WKWebView swapchain may
   * have been silently released while we were hidden; we need a
   * fresh `context.configure(...)` to land on a live surface.
   *
   * Cheap (one boolean write). Safe to call repeatedly. Has no
   * effect on the renderer's current frame — it only changes what
   * the NEXT resize does.
   */
  markHidden(): void {
    this.needsReconfigure = true;
  }

  /**
   * True once the underlying GPUDevice is lost. Callers should
   * destroy this renderer and bootstrap a replacement.
   */
  get isLost(): boolean {
    return this.lost;
  }

  /**
   * Internal — wired up by createGridRenderer's device.lost handler.
   * Exported so the bootstrap can flip the flag without exposing a
   * generic setter on the public surface.
   */
  markLost(): void {
    this.lost = true;
  }

  /**
   * Cell size in CSS pixels. Hit-test code in CanvasGrid uses this to
   * convert mouse coordinates into (row, col) without duplicating the
   * atlas measurement (which depends on font + DPR and shouldn't drift).
   */
  get cellSize(): CellSize {
    return {
      widthCss: this.atlas.cellWidthCss,
      heightCss: this.atlas.cellHeightCss,
    };
  }

  /**
   * Force the next `render()` call to bypass seq dedupe. Used by
   * callers that change render-time state which doesn't bump `seq`
   * — currently just the selection range (the underlying frame
   * hasn't changed, but the visible output must repaint).
   */
  invalidate(): void {
    this.lastSeq = -1;
  }

  /**
   * Convenience: render a full RenderFrame (alt-screen / full-pane
   * case). Iterates `frame.dirty` and pulls cursor from frame.
   */
  renderFrame(frame: RenderFrame | null): void {
    if (!frame) {
      this.draw(0);
      return;
    }
    // RenderFrame.dirty IS the full grid for the alt-screen / full-pane
    // case (the backend sends every row in this mode), so `cursor_row`
    // — a row index into the original grid — is also a valid index
    // into rows.
    this.render({
      rows: frame.dirty,
      cols: frame.cols,
      seq: frame.seq,
      cursor: {
        row: frame.cursor_row,
        col: frame.cursor_col,
        // DECTCEM. Suppress the cursor draw when the running program
        // has hidden it (claude's picker, fzf, vim normal mode, etc).
        visible: frame.cursor_visible !== false,
      },
    });
  }

  render(input: RenderInput): void {
    if (this.lost) return;
    if (input.seq === this.lastSeq) return;
    this.lastSeq = input.seq;

    let count = 0;
    for (const dr of input.rows) {
      for (const span of dr.spans) {
        // Count by Unicode code-point sequences (we render one cell per
        // code point; combining marks would ideally cluster, but that's
        // a future refinement and the cells past the base are blanks
        // either way since alacritty inlines combining marks into the
        // base cell's zerowidth list).
        count += stringLengthInCodepoints(span.text);
      }
    }

    const cursor = input.cursor;
    const drawCursor =
      cursor !== null &&
      cursor !== undefined &&
      cursor.visible &&
      cursor.row >= 0 &&
      cursor.row < input.rows.length &&
      cursor.col >= 0 &&
      cursor.col < input.cols;
    const totalCount = count + (drawCursor ? 1 : 0);

    if (totalCount === 0) {
      this.draw(0);
      return;
    }

    if (totalCount > this.instanceCapacity) {
      this.growInstanceBuffer(totalCount);
    }
    const neededBytes = totalCount * BYTES_PER_CELL;
    if (this.scratch.byteLength < neededBytes) {
      const cap = nextPow2(neededBytes);
      this.scratch = new ArrayBuffer(cap);
      this.scratchF32 = new Float32Array(this.scratch);
      this.scratchU32 = new Uint32Array(this.scratch);
    }

    // Normalise selection so `start` is always (row, col)-lexicographically
    // before `end`. The caller doesn't have to track drag direction.
    const sel = input.selection ?? null;
    let selStartRow = 0;
    let selStartCol = 0;
    let selEndRow = 0;
    let selEndCol = 0;
    let hasSel = false;
    if (sel) {
      const aBefore =
        sel.startRow < sel.endRow ||
        (sel.startRow === sel.endRow && sel.startCol <= sel.endCol);
      selStartRow = aBefore ? sel.startRow : sel.endRow;
      selStartCol = aBefore ? sel.startCol : sel.endCol;
      selEndRow = aBefore ? sel.endRow : sel.startRow;
      selEndCol = aBefore ? sel.endCol : sel.startCol;
      // Empty range (anchor == cursor before any drag) is treated as
      // no selection so the user doesn't see a single-cell highlight
      // on a mouse-down with no drag.
      hasSel = !(selStartRow === selEndRow && selStartCol === selEndCol);
    }

    const f32 = this.scratchF32;
    const u32 = this.scratchU32;
    let slot = 0;
    for (let r = 0; r < input.rows.length; r++) {
      const dr = input.rows[r];
      // Windowed rows render packed top-down regardless of dr.row.
      // Callers using dr.row as a grid coordinate (alt-screen full
      // frame) get the same answer because dr.row matches r in that
      // mode anyway.
      const row = r;
      let col = 0;
      for (const span of dr.spans) {
        const fg = parseColor(span.fg, [1, 1, 1, 1]);
        const bg = parseColor(span.bg, [0, 0, 0, 0]);
        const fr = span.inverse ? bg[0] : fg[0];
        const fgG = span.inverse ? bg[1] : fg[1];
        const fb = span.inverse ? bg[2] : fg[2];
        const fa = span.inverse ? bg[3] : fg[3];
        const br = span.inverse ? fg[0] : bg[0];
        const bgG = span.inverse ? fg[1] : bg[1];
        const bb = span.inverse ? fg[2] : bg[2];
        const ba = span.inverse ? fg[3] : bg[3];
        const dim = span.dim ? 0.6 : 1;
        const style: GlyphStyle = span.bold ? 1 : span.italic ? 2 : 0;
        const baseFlags =
          (span.underline ? FLAG_UNDERLINE : 0) |
          (span.strikeout ? FLAG_STRIKE : 0);
        // Walk by grapheme code point so emoji + supplementary-plane
        // chars get their own cell instead of being split into two
        // half-cells (which would render as garbled pairs).
        for (const ch of span.text) {
          let flags = baseFlags;
          if (hasSel && isInRange(row, col, selStartRow, selStartCol, selEndRow, selEndCol)) {
            flags |= FLAG_SELECTED;
          }
          const entry = this.atlas.lookup(ch, style, ch);
          const offBytes = slot * BYTES_PER_CELL;
          const offF32 = offBytes / 4;
          const offU32 = offBytes / 4;
          f32[offF32 + 0] = col;
          f32[offF32 + 1] = row;
          if (entry) {
            f32[offF32 + 2] = entry.u;
            f32[offF32 + 3] = entry.v;
            f32[offF32 + 4] = entry.w;
            f32[offF32 + 5] = entry.h;
          } else {
            f32[offF32 + 2] = 0;
            f32[offF32 + 3] = 0;
            f32[offF32 + 4] = 0;
            f32[offF32 + 5] = 0;
          }
          f32[offF32 + 6] = fr * dim;
          f32[offF32 + 7] = fgG * dim;
          f32[offF32 + 8] = fb * dim;
          f32[offF32 + 9] = fa;
          f32[offF32 + 10] = br;
          f32[offF32 + 11] = bgG;
          f32[offF32 + 12] = bb;
          f32[offF32 + 13] = ba;
          u32[offU32 + 14] = flags;
          slot++;
          col++;
        }
      }
    }

    if (drawCursor && cursor) {
      // Block cursor: solid accent fill, no glyph (atlas size = 0).
      // The fragment shader's underline/strike + selection paths are
      // all suppressed by FLAG_CURSOR so the cursor reads as a clean
      // solid block — no overlay can dim or notch it.
      //
      // Crucially the cursor's bg alpha is 1.0 (fully opaque) so when
      // the user has the cursor cell inside a selection, the cursor
      // block FULLY replaces the selection-overlaid glyph cell
      // underneath. Anything < 1.0 here lets the selection's blue
      // tint bleed through and the cursor visually "fades out" — the
      // bug users described as the cursor disappearing on shift-click.
      const offBytes = slot * BYTES_PER_CELL;
      const offF32 = offBytes / 4;
      const offU32 = offBytes / 4;
      f32[offF32 + 0] = cursor.col;
      f32[offF32 + 1] = cursor.row;
      f32[offF32 + 2] = 0;
      f32[offF32 + 3] = 0;
      f32[offF32 + 4] = 0;
      f32[offF32 + 5] = 0;
      f32[offF32 + 6] = 0;
      f32[offF32 + 7] = 0;
      f32[offF32 + 8] = 0;
      f32[offF32 + 9] = 0;
      f32[offF32 + 10] = 0.92;
      f32[offF32 + 11] = 0.92;
      f32[offF32 + 12] = 0.92;
      f32[offF32 + 13] = 1.0;
      u32[offU32 + 14] = FLAG_CURSOR;
      slot++;
    }

    this.device.queue.writeBuffer(
      this.instanceBuffer!,
      0,
      this.scratch,
      0,
      slot * BYTES_PER_CELL,
    );

    // Project in PHYSICAL pixels so cells land on integer device-pixel
    // boundaries — see the shader header for the why. `cellWidthPx` /
    // `cellHeightPx` are the atlas's physical cell dims (already
    // computed with DPR applied), and the viewport is canvas.width /
    // canvas.height physical pixels.
    const canvas = this.context.canvas as HTMLCanvasElement;
    const uniforms = new Float32Array([
      this.atlas.cellWidthPx,
      this.atlas.cellHeightPx,
      canvas.width,
      canvas.height,
      0,
      0,
      0,
      0,
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    this.draw(slot);
  }

  destroy(): void {
    // Don't poke at GPU resources after device loss — destroy() on a
    // lost device throws validation errors. The browser already
    // cleans them up; we just drop our references.
    if (!this.lost) {
      try {
        this.atlas.destroy();
        this.uniformBuffer.destroy();
        this.quadBuffer.destroy();
        this.instanceBuffer?.destroy();
      } catch {
        // A race between `device.lost` resolving and destroy() being
        // called can land us here. The browser is in the middle of
        // tearing the device down — nothing useful left to do.
      }
    }
    this.instanceBuffer = null;
  }

  private growInstanceBuffer(needed: number): void {
    this.instanceCapacity = nextPow2(needed);
    this.instanceBuffer?.destroy();
    this.instanceBuffer = this.device.createBuffer({
      size: this.instanceCapacity * BYTES_PER_CELL,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  private draw(instanceCount: number): void {
    // Heartbeat: every HEARTBEAT_FRAMES successful paints, force a
    // pre-emptive reconfigure of the swapchain. The user-visible bug
    // this catches is "agent shell goes black mid-run, no tab switch,
    // no resize" — WKWebView can silently release the GPU surface
    // and the next `getCurrentTexture()` returns a texture that
    // paints into the void (no throw, no device.lost, nothing to
    // hook). The visibility-restore + resize-time reconfigure paths
    // only fire on a state change; if the page is sitting still
    // while frames flow in, neither helps. The heartbeat is the
    // safety net.
    //
    // Cheap by design: at sustained 60Hz the cost is one configure
    // every HEARTBEAT_FRAMES frames (≈ 1 Hz at the default). On a
    // healthy surface the browser short-circuits configure() with
    // the same descriptor, so the wall-clock impact is sub-percent
    // of frame time.
    if (this.framesSinceReconfigure >= HEARTBEAT_FRAMES) {
      this.needsReconfigure = true;
    }
    // If the previous draw flagged a dead swapchain, reconfigure
    // BEFORE attempting another getCurrentTexture(). Skipping the
    // reconfigure would just re-throw and leave the canvas black.
    if (this.needsReconfigure) {
      this.reconfigure();
    }
    let view: GPUTextureView;
    try {
      view = this.context.getCurrentTexture().createView();
    } catch (err) {
      // The swapchain is dead. Reconfigure to acquire a new one and
      // retry once. If THAT still fails, give up on this frame —
      // the next ResizeObserver / visibility-restore tick will re-
      // try. (The renderer is not "lost" — the device is fine; only
      // the surface needs to be re-attached.)
      this.needsReconfigure = true;
      this.reconfigure();
      try {
        view = this.context.getCurrentTexture().createView();
      } catch {
        // eslint-disable-next-line no-console
        console.warn(
          "[GridRenderer] getCurrentTexture failed twice; skipping frame:",
          err,
        );
        // Force the next render to re-attempt (don't dedupe on the
        // skipped seq).
        this.lastSeq = -1;
        return;
      }
    }
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        },
      ],
    });
    if (instanceCount > 0 && this.instanceBuffer) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.quadBuffer);
      pass.setVertexBuffer(1, this.instanceBuffer);
      pass.draw(6, instanceCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    // Heartbeat tally: only count frames we actually submitted to
    // the GPU. Skipped frames (the early `return` paths in the
    // try/catch above) deliberately don't tick the counter so a
    // pathological dead-surface run doesn't trip the heartbeat
    // before the draw-retry path has had a chance to recover.
    this.framesSinceReconfigure++;
  }
}

/**
 * Count user-perceived characters in a string by iterating code points
 * (the for..of iterator yields one element per code point, handling
 * surrogate pairs correctly). Emoji + supplementary-plane chars come
 * back as one element instead of two.
 */
function stringLengthInCodepoints(s: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++;
  return n;
}

/**
 * Inclusive on start, exclusive on end — terminal selection semantics
 * to match the DOM behaviour where dragging-then-releasing on the
 * same cell as the anchor selects nothing. (row, col) ordering is
 * lexicographic: (3, 5) > (3, 4) but (3, 5) < (4, 0).
 *
 * Caller is responsible for canonicalising start ≤ end. This helper
 * just asks "is (row, col) inside this normalised half-open range?"
 */
function isInRange(
  row: number,
  col: number,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): boolean {
  // Strictly above start row or strictly below end row → outside.
  if (row < startRow || row > endRow) return false;
  // On the start row: must be at or past startCol.
  if (row === startRow && col < startCol) return false;
  // On the end row: must be strictly before endCol (half-open).
  if (row === endRow && col >= endCol) return false;
  return true;
}

function parseColor(
  css: string,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (!css || css === "transparent") return [0, 0, 0, 0];
  if (css.charCodeAt(0) === 35 /* # */) {
    if (css.length === 7) {
      return [
        parseInt(css.slice(1, 3), 16) / 255,
        parseInt(css.slice(3, 5), 16) / 255,
        parseInt(css.slice(5, 7), 16) / 255,
        1,
      ];
    }
    if (css.length === 4) {
      const r = parseInt(css[1], 16);
      const g = parseInt(css[2], 16);
      const b = parseInt(css[3], 16);
      return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255, 1];
    }
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(css);
  if (m) {
    return [
      parseInt(m[1]) / 255,
      parseInt(m[2]) / 255,
      parseInt(m[3]) / 255,
      m[4] === undefined ? 1 : parseFloat(m[4]),
    ];
  }
  return fallback;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Bootstrap a renderer for a given canvas. Throws if WebGPU is not
 * available — Goonware ships only as a Tauri DMG on macOS 14+, so this
 * is a configuration error worth surfacing loudly rather than a
 * fallback path.
 */
export async function createGridRenderer(
  canvas: HTMLCanvasElement,
  font: string,
  fontSizeCss: number,
  lineHeight: number,
  onDeviceLost?: (info: { reason: string; message: string }) => void,
): Promise<GridRenderer> {
  if (!navigator.gpu) {
    throw new Error("WebGPU not available — Goonware requires macOS 14+");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter available");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Canvas WebGPU context unavailable");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "premultiplied",
  });
  // Wait for webfonts (specifically JetBrains Mono) to finish loading
  // before the atlas pre-rasterizes its tofu glyph. Without this, on
  // cold start the OffscreenCanvas falls back to a system monospace
  // that doesn't carry box-drawing chars (U+2500..U+257F), the atlas
  // caches the fallback's empty / replacement glyph forever, and
  // claude's input box renders as a blank rectangle. The user
  // reproed it as "the bottom is cutting out" — claude's TUI box was
  // there, just painted with invisible glyphs.
  //
  // document.fonts.ready resolves once all font-face declarations in
  // the active stylesheets have finished loading. Cheap when fonts
  // are already ready (typical hot path); a few-ms wait otherwise.
  if (typeof document !== "undefined" && document.fonts) {
    try {
      await document.fonts.ready;
    } catch {
      // Some embedded environments stub document.fonts incompletely.
      // Continuing without the wait is no worse than the pre-fix
      // behaviour, so swallow and move on.
    }
  }
  const dpr = window.devicePixelRatio || 1;
  const atlas = createAtlas(device, {
    font,
    fontSizeCss,
    lineHeight,
    dpr,
  });
  const renderer = new GridRenderer(device, context, format, atlas);

  // device.lost resolves once and only once — on driver reset, system
  // sleep/wake on some GPUs, or an unrecoverable validation error.
  // We flip the renderer to a lost state so subsequent draws no-op,
  // then notify the caller so it can swap in a replacement. Caller
  // is responsible for tearing the dead renderer down via destroy().
  void device.lost
    .then((info) => {
      renderer.markLost();
      // `reason` is "destroyed" when we explicitly tore the device
      // down ourselves (component unmount) — not an error, just the
      // normal shutdown path. Don't pester the caller in that case.
      if (info.reason === "destroyed") return;
      onDeviceLost?.({ reason: info.reason, message: info.message });
    })
    .catch(() => {
      // device.lost never rejects in the spec; defensive catch just
      // in case a browser implementation surprises us.
    });

  return renderer;
}

// Re-export so call sites can pull `Span` from one place.
export type { Span };
