import type { CSSProperties, ReactNode } from "react";
import {
  GearIcon,
  SlidersHorizontalIcon,
  ImageIcon,
  HexagonIcon,
  GitBranchIcon,
  LockIcon,
  FileCssIcon,
  FileHtmlIcon,
  FilePyIcon,
  FileCodeIcon,
  FileTextIcon,
  FileSqlIcon,
  CoffeeIcon,
} from "@phosphor-icons/react";

/**
 * Per-extension file icon. Mixed rendering: short colored chips for
 * languages with a recognizable two-letter mark (TS/JS/Rs/Go/Py),
 * Phosphor line icons for files with a clear "category" glyph
 * (settings/cog for envs, lock for locks, image for media), and
 * hand-drawn SVG for files that need a brand silhouette (Docker
 * whale, markdown's M↓).
 *
 * Three lookup layers, in order:
 *   1. Whole filename (case-insensitive) — Dockerfile, package.json,
 *      .gitignore, Cargo.lock, etc.
 *   2. Filename pattern (regex) — Dockerfile.<variant>,
 *      tsconfig.*.json, vite.config.{ts,js,…}, *.d.ts,
 *      *.tsbuildinfo, etc.
 *   3. Extension — .ts, .json, .py, .rs, …
 *
 * Falls back to a quiet outlined document for anything unknown.
 */

interface Props {
  name: string;
  isDir: boolean;
  open?: boolean;
  size?: number;
  style?: CSSProperties;
}

/* Restrained palette. Built in OKLCH at consistent mid-lightness
   (~60-72%) and low-to-mid chroma so file-type colors sit calmly
   against `oklch(7-13% 0.004 250)` surfaces. Hue stays recognizable
   as the language's brand — TypeScript blue stays blue, Ruby stays
   red — but saturation is pulled in. */
const C = {
  // Languages
  ts:        "oklch(64% 0.12 245)",
  js:        "oklch(82% 0.13 95)",
  python:    "oklch(62% 0.10 235)",
  ruby:      "oklch(60% 0.13 25)",
  rust:      "oklch(58% 0.13 30)",
  go:        "oklch(70% 0.11 220)",
  swift:     "oklch(70% 0.14 50)",
  java:      "oklch(64% 0.14 55)",
  kotlin:    "oklch(68% 0.13 305)",
  scala:     "oklch(60% 0.13 25)",
  cpp:       "oklch(68% 0.07 270)",
  csharp:    "oklch(62% 0.13 320)",
  php:       "oklch(64% 0.07 270)",
  shell:     "oklch(74% 0.16 140)",
  dart:      "oklch(70% 0.12 210)",
  elixir:    "oklch(66% 0.13 295)",
  erlang:    "oklch(58% 0.13 25)",
  haskell:   "oklch(64% 0.13 295)",
  fsharp:    "oklch(64% 0.12 245)",
  ocaml:     "oklch(66% 0.14 55)",
  clojure:   "oklch(64% 0.13 145)",
  lua:       "oklch(60% 0.13 245)",
  perl:      "oklch(62% 0.13 245)",
  r:         "oklch(62% 0.12 245)",
  julia:     "oklch(60% 0.16 320)",
  nim:       "oklch(72% 0.13 90)",
  zig:       "oklch(72% 0.14 70)",
  groovy:    "oklch(64% 0.13 200)",
  // Web/markup
  html:      "oklch(64% 0.16 35)",
  css:       "oklch(60% 0.15 250)",
  vue:       "oklch(70% 0.14 155)",
  svelte:    "oklch(66% 0.17 30)",
  // Data
  json:      "oklch(70% 0.12 90)",
  yaml:      "oklch(60% 0.15 25)",
  toml:      "oklch(62% 0.02 250)",
  xml:       "oklch(66% 0.14 55)",
  sql:       "oklch(64% 0.13 210)",
  markdown:  "oklch(68% 0.02 250)",
  text:      "oklch(68% 0.02 250)",
  // Brand / ecosystem
  docker:    "oklch(66% 0.13 235)",
  git:       "oklch(62% 0.17 30)",
  npm:       "oklch(60% 0.15 25)",
  yarn:      "oklch(64% 0.13 235)",
  vite:      "oklch(72% 0.13 305)",
  next:      "oklch(85% 0.005 250)",
  tailwind:  "oklch(70% 0.13 210)",
  webpack:   "oklch(66% 0.13 235)",
  rollup:    "oklch(64% 0.17 30)",
  prettier:  "oklch(70% 0.13 50)",
  eslint:    "oklch(66% 0.13 295)",
  babel:     "oklch(78% 0.13 90)",
  gradle:    "oklch(66% 0.13 200)",
  maven:     "oklch(62% 0.13 25)",
  // Generic
  image:     "oklch(68% 0.14 155)",
  pdf:       "oklch(60% 0.17 25)",
  video:     "oklch(64% 0.15 305)",
  audio:     "oklch(70% 0.13 320)",
  archive:   "oklch(62% 0.02 250)",
  lock:      "oklch(72% 0.13 75)",
  env:       "oklch(78% 0.13 90)",
  config:    "oklch(62% 0.02 250)",
  key:       "oklch(72% 0.13 75)",
};

/** Single dark cool-neutral ink for filled chips. Same hue family as
 *  the rest of the app's text. */
const CHIP_FG = "oklch(18% 0.005 250)";

/**
 * A renderer takes a size and returns the JSX for the icon. Letting
 * each spec choose its own JSX lets us mix chip-style badges with
 * line icons and hand-drawn SVG in the same registry.
 */
type Renderer = (size: number) => ReactNode;

/* ------------------------------------------------------------------
   Building blocks
   ------------------------------------------------------------------ */

/**
 * Filled colored chip. Background carries the brand color; text in
 * a single dark ink (`CHIP_FG`) so all chips share one foreground
 * tone instead of fighting per-chip white/black overrides.
 */
function Chip({
  size,
  bg,
  text,
  rounded = 3,
}: {
  size: number;
  bg: string;
  text: string;
  rounded?: number;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        backgroundColor: bg,
        color: CHIP_FG,
        borderRadius: rounded,
        fontFamily: "var(--font-mono)",
        fontSize: Math.max(7, Math.round(size * 0.6)),
        fontWeight: 700,
        letterSpacing: "-0.06em",
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      {text}
    </span>
  );
}

/**
 * Pure-color line-icon wrapper. Drops a Phosphor component (or any
 * other component that accepts `size` / `color`) into a fixed
 * inline-flex box so width/height are stable across all variants.
 */
/** Optical scale factor — the glyph paths span ~78% of their
 *  viewBox; scaling the rendered glyph up by this amount makes the
 *  visible ink match the filled chips painted at full container
 *  size. The wrapper's bounding box is unchanged, so flex alignment
 *  is identical to chips and the box-to-box positions across rows
 *  line up to the pixel. Phosphor controls line weight via `weight`
 *  (default `regular`) rather than a numeric stroke. */
const LINE_ICON_SCALE = 1.3;

function LineIcon({
  size,
  color,
  Component,
}: {
  size: number;
  color: string;
  Component: React.ComponentType<{
    size?: number | string;
    color?: string;
  }>;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${LINE_ICON_SCALE})`,
          transformOrigin: "center",
        }}
      >
        <Component size={size} color={color} />
      </span>
    </span>
  );
}

/** Docker whale silhouette. Simplified, single-color fill. Scaled
 *  uniformly with the rest of the SVG icons so its visible glyph
 *  matches the chip's filled area. */
function DockerWhale({ size, color }: { size: number; color: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={color}
        style={{ display: "block", transform: `scale(${LINE_ICON_SCALE})` }}
      >
        <rect x="3" y="9" width="3" height="3" rx="0.4" />
        <rect x="6.6" y="9" width="3" height="3" rx="0.4" />
        <rect x="10.2" y="9" width="3" height="3" rx="0.4" />
        <rect x="13.8" y="9" width="3" height="3" rx="0.4" />
        <rect x="6.6" y="5.6" width="3" height="3" rx="0.4" />
        <rect x="10.2" y="5.6" width="3" height="3" rx="0.4" />
        <rect x="13.8" y="5.6" width="3" height="3" rx="0.4" />
        <rect x="10.2" y="2.2" width="3" height="3" rx="0.4" />
        <path d="M21 12.8c-.4-.4-1.2-.6-1.9-.5-.1-.7-.6-1.3-1.2-1.6l-.4-.2-.3.4c-.5.6-.6 1.5-.2 2.2.2.3.4.6.8.7-.5.3-1.4.4-2.1.4H2c-.1.7 0 1.4.2 2.1.5 1.4 1.5 2.4 2.9 2.9 1.6.6 3.5.9 5.5.9 1 0 2-.1 2.9-.3a8.7 8.7 0 0 0 4.7-2.8c.8-.9 1.5-2 1.9-3.2.6 0 1.7 0 2.2-1l.1-.3-.4-.3a3 3 0 0 0-.9-.4Z" />
      </svg>
    </span>
  );
}

/** Markdown badge — rounded square with "M↓". Cool-grey, no brand. */
function MarkdownBadge({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        backgroundColor: "oklch(28% 0.005 250)",
        borderRadius: 3,
        color: "oklch(85% 0.005 250)",
        fontFamily: "var(--font-mono)",
        fontSize: Math.max(6, Math.round(size * 0.5)),
        fontWeight: 700,
        letterSpacing: "-0.08em",
        lineHeight: 1,
        userSelect: "none",
        gap: 0,
      }}
    >
      <span>M</span>
      <span style={{ fontSize: Math.max(7, Math.round(size * 0.55)) }}>↓</span>
    </span>
  );
}

/* ------------------------------------------------------------------
   Registries
   ------------------------------------------------------------------ */

/**
 * Whole-filename matches take priority. Keys are lowercased so the
 * lookup can be case-insensitive at the callsite.
 */
const FILENAME_RENDERERS: Record<string, Renderer> = {
  // Docker
  "dockerfile":            (s) => <DockerWhale size={s} color={C.docker} />,
  ".dockerignore":         (s) => <DockerWhale size={s} color={C.docker} />,
  "docker-compose.yml":    (s) => <DockerWhale size={s} color={C.docker} />,
  "docker-compose.yaml":   (s) => <DockerWhale size={s} color={C.docker} />,
  "compose.yml":           (s) => <DockerWhale size={s} color={C.docker} />,
  "compose.yaml":          (s) => <DockerWhale size={s} color={C.docker} />,
  ".devcontainer.json":    (s) => <DockerWhale size={s} color={C.docker} />,

  // Git
  ".git":             (s) => <LineIcon size={s} color={C.git} Component={GitBranchIcon} />,
  ".gitignore":       (s) => <LineIcon size={s} color={C.git} Component={GitBranchIcon} />,
  ".gitattributes":   (s) => <LineIcon size={s} color={C.git} Component={GitBranchIcon} />,
  ".gitmodules":      (s) => <LineIcon size={s} color={C.git} Component={GitBranchIcon} />,
  ".gitkeep":         (s) => <LineIcon size={s} color={C.git} Component={GitBranchIcon} />,

  // Env / generic config
  ".env":              (s) => <LineIcon size={s} color={C.env} Component={GearIcon} />,
  ".env.local":        (s) => <LineIcon size={s} color={C.env} Component={GearIcon} />,
  ".env.development":  (s) => <LineIcon size={s} color={C.env} Component={GearIcon} />,
  ".env.production":   (s) => <LineIcon size={s} color={C.env} Component={GearIcon} />,
  ".env.test":         (s) => <LineIcon size={s} color={C.env} Component={GearIcon} />,
  ".env.example":      (s) => <LineIcon size={s} color={C.config} Component={SlidersHorizontalIcon} />,
  ".env.sample":       (s) => <LineIcon size={s} color={C.config} Component={SlidersHorizontalIcon} />,
  ".env.template":     (s) => <LineIcon size={s} color={C.config} Component={SlidersHorizontalIcon} />,
  ".editorconfig":     (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  ".browserslistrc":   (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  ".nvmrc":            (s) => <LineIcon size={s} color={C.shell} Component={HexagonIcon} />,
  ".node-version":     (s) => <LineIcon size={s} color={C.shell} Component={HexagonIcon} />,
  ".ruby-version":     (s) => <Chip size={s} bg={C.ruby} text="Rb" />,
  ".python-version":   (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  ".tool-versions":    (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,

  // Linters / formatters
  ".prettierrc":          (s) => <Chip size={s} bg={C.prettier} text="Pr" />,
  ".prettierrc.json":     (s) => <Chip size={s} bg={C.prettier} text="Pr" />,
  ".prettierrc.yml":      (s) => <Chip size={s} bg={C.prettier} text="Pr" />,
  ".prettierrc.yaml":     (s) => <Chip size={s} bg={C.prettier} text="Pr" />,
  ".prettierrc.js":       (s) => <Chip size={s} bg={C.prettier} text="Pr" />,
  ".prettierignore":      (s) => <Chip size={s} bg={C.prettier} text="Pr" />,
  ".eslintrc":            (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  ".eslintrc.json":       (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  ".eslintrc.js":         (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  ".eslintrc.cjs":        (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  ".eslintrc.yml":        (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  ".eslintrc.yaml":       (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  ".eslintignore":        (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  "eslint.config.js":     (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  "eslint.config.mjs":    (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  "eslint.config.ts":     (s) => <Chip size={s} bg={C.eslint} text="ES" />,
  ".babelrc":             (s) => <Chip size={s} bg={C.babel} text="Bb" />,
  ".babelrc.json":        (s) => <Chip size={s} bg={C.babel} text="Bb" />,
  ".stylelintrc":         (s) => <Chip size={s} bg={C.css} text="St" />,
  ".stylelintrc.json":    (s) => <Chip size={s} bg={C.css} text="St" />,

  // Node ecosystem
  "package.json":      (s) => <LineIcon size={s} color={C.npm} Component={HexagonIcon} />,
  "package-lock.json": (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  ".npmrc":            (s) => <LineIcon size={s} color={C.npm} Component={HexagonIcon} />,
  ".yarnrc":           (s) => <LineIcon size={s} color={C.yarn} Component={HexagonIcon} />,
  ".yarnrc.yml":       (s) => <LineIcon size={s} color={C.yarn} Component={HexagonIcon} />,
  "yarn.lock":         (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "pnpm-lock.yaml":    (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "pnpm-workspace.yaml":(s)=> <LineIcon size={s} color={C.config} Component={GearIcon} />,
  "bun.lock":          (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "bun.lockb":         (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "bunfig.toml":       (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,

  // Python ecosystem
  "requirements.txt":   (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  "requirements.lock":  (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "pyproject.toml":     (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  "pipfile":            (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  "pipfile.lock":       (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "setup.py":           (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  "setup.cfg":          (s) => <LineIcon size={s} color={C.python} Component={GearIcon} />,
  "poetry.lock":        (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,

  // Ruby ecosystem
  "gemfile":         (s) => <Chip size={s} bg={C.ruby} text="Rb" />,
  "gemfile.lock":    (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "rakefile":        (s) => <Chip size={s} bg={C.ruby} text="Rk" />,

  // Rust ecosystem
  "cargo.toml":      (s) => <Chip size={s} bg={C.rust} text="Cg" />,
  "cargo.lock":      (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "rustfmt.toml":    (s) => <Chip size={s} bg={C.rust} text="Rs" />,
  "clippy.toml":     (s) => <Chip size={s} bg={C.rust} text="Cl" />,
  "rust-toolchain.toml":(s)=> <Chip size={s} bg={C.rust} text="Rs" />,

  // Go ecosystem
  "go.mod":   (s) => <Chip size={s} bg={C.go} text="Go" />,
  "go.sum":   (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  "go.work":  (s) => <Chip size={s} bg={C.go} text="Go" />,

  // JVM ecosystem
  "build.gradle":          (s) => <Chip size={s} bg={C.gradle} text="Gr" />,
  "build.gradle.kts":      (s) => <Chip size={s} bg={C.gradle} text="Gr" />,
  "settings.gradle":       (s) => <Chip size={s} bg={C.gradle} text="Gr" />,
  "settings.gradle.kts":   (s) => <Chip size={s} bg={C.gradle} text="Gr" />,
  "pom.xml":               (s) => <Chip size={s} bg={C.maven} text="Mv" />,

  // PHP ecosystem
  "composer.json":  (s) => <Chip size={s} bg={C.php} text="Ph" />,
  "composer.lock":  (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,

  // Build systems / misc
  "makefile":         (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  "gnumakefile":      (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  "cmakelists.txt":   (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  "jenkinsfile":      (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  "procfile":         (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  "vagrantfile":      (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,

  // Readmes / licenses / common docs
  "readme.md":        (s) => <MarkdownBadge size={s} />,
  "readme":           (s) => <MarkdownBadge size={s} />,
  "readme.txt":       (s) => <MarkdownBadge size={s} />,
  "changelog.md":     (s) => <MarkdownBadge size={s} />,
  "changelog":        (s) => <MarkdownBadge size={s} />,
  "contributing.md":  (s) => <MarkdownBadge size={s} />,
  "code_of_conduct.md":(s) => <MarkdownBadge size={s} />,
  "authors":          (s) => <LineIcon size={s} color={C.config} Component={FileTextIcon} />,
  "license":          (s) => <LineIcon size={s} color={C.config} Component={LockIcon} />,
  "license.md":       (s) => <LineIcon size={s} color={C.config} Component={LockIcon} />,
  "license.txt":      (s) => <LineIcon size={s} color={C.config} Component={LockIcon} />,
};

/**
 * Filename patterns (regex). Checked AFTER exact-name match but
 * BEFORE extension. Order matters: first hit wins.
 */
const FILENAME_PATTERNS: { pattern: RegExp; render: Renderer }[] = [
  // Docker family
  { pattern: /^Dockerfile(\.|$)/i,
    render: (s) => <DockerWhale size={s} color={C.docker} /> },
  // tsconfig family — all JSON tsconfigs and tsbuildinfo siblings
  { pattern: /^tsconfig(\..+)?\.json$/i,
    render: (s) => <Chip size={s} bg={C.ts} text="TS" /> },
  { pattern: /\.tsbuildinfo$/i,
    render: (s) => <Chip size={s} bg={C.ts} text="TS" /> },
  { pattern: /\.d\.ts$/i,
    render: (s) => <Chip size={s} bg={C.ts} text="DT" /> },
  // Framework configs — one entry per known config family
  { pattern: /^vite\.config\.(ts|js|mjs|cjs|mts|cts)$/i,
    render: (s) => <Chip size={s} bg={C.vite} text="Vi" /> },
  { pattern: /^next\.config\.(ts|js|mjs|cjs|mts|cts)$/i,
    render: (s) => <Chip size={s} bg={C.next} text="Nx" /> },
  { pattern: /^tailwind\.config\.(ts|js|mjs|cjs|mts|cts)$/i,
    render: (s) => <Chip size={s} bg={C.tailwind} text="Tw" /> },
  { pattern: /^webpack\.config\.(ts|js|mjs|cjs|mts|cts)$/i,
    render: (s) => <Chip size={s} bg={C.webpack} text="Wp" /> },
  { pattern: /^rollup\.config\.(ts|js|mjs|cjs|mts|cts)$/i,
    render: (s) => <Chip size={s} bg={C.rollup} text="Rl" /> },
  // Other JS/TS configs — generic settings cog
  { pattern: /^(babel|postcss|jest|vitest|cypress|playwright|svelte|astro|remix|nuxt|drizzle|prisma|wrangler|fly)\.config\.(ts|js|mjs|cjs|mts|cts|json)$/i,
    render: (s) => <LineIcon size={s} color={C.config} Component={GearIcon} /> },
];

/**
 * Extension → renderer. Keys are lowercase.
 */
const EXT_RENDERERS: Record<string, Renderer> = {
  // TypeScript / JavaScript
  ts:    (s) => <Chip size={s} bg={C.ts} text="TS" />,
  tsx:   (s) => <Chip size={s} bg={C.ts} text="TS" />,
  mts:   (s) => <Chip size={s} bg={C.ts} text="TS" />,
  cts:   (s) => <Chip size={s} bg={C.ts} text="TS" />,
  js:    (s) => <Chip size={s} bg={C.js} text="JS" />,
  jsx:   (s) => <Chip size={s} bg={C.js} text="JS" />,
  mjs:   (s) => <Chip size={s} bg={C.js} text="JS" />,
  cjs:   (s) => <Chip size={s} bg={C.js} text="JS" />,

  // Other languages
  py:    (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  pyc:   (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  pyi:   (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  pyw:   (s) => <LineIcon size={s} color={C.python} Component={FilePyIcon} />,
  ipynb: (s) => <Chip size={s} bg={C.python} text="Nb" />,
  rb:    (s) => <Chip size={s} bg={C.ruby} text="Rb" />,
  erb:   (s) => <Chip size={s} bg={C.ruby} text="Eb" />,
  rs:    (s) => <Chip size={s} bg={C.rust} text="Rs" />,
  go:    (s) => <Chip size={s} bg={C.go} text="Go" />,
  swift: (s) => <Chip size={s} bg={C.swift} text="Sw" />,
  java:  (s) => <LineIcon size={s} color={C.java} Component={CoffeeIcon} />,
  class: (s) => <LineIcon size={s} color={C.java} Component={CoffeeIcon} />,
  jar:   (s) => <LineIcon size={s} color={C.java} Component={CoffeeIcon} />,
  kt:    (s) => <Chip size={s} bg={C.kotlin} text="Kt" />,
  kts:   (s) => <Chip size={s} bg={C.kotlin} text="Kt" />,
  scala: (s) => <Chip size={s} bg={C.scala} text="Sc" />,
  sc:    (s) => <Chip size={s} bg={C.scala} text="Sc" />,
  c:     (s) => <Chip size={s} bg={C.cpp} text="C" />,
  h:     (s) => <Chip size={s} bg={C.cpp} text="H" />,
  cpp:   (s) => <Chip size={s} bg={C.cpp} text="C+" />,
  cc:    (s) => <Chip size={s} bg={C.cpp} text="C+" />,
  cxx:   (s) => <Chip size={s} bg={C.cpp} text="C+" />,
  hpp:   (s) => <Chip size={s} bg={C.cpp} text="H+" />,
  hxx:   (s) => <Chip size={s} bg={C.cpp} text="H+" />,
  cs:    (s) => <Chip size={s} bg={C.csharp} text="Cs" />,
  csproj:(s) => <Chip size={s} bg={C.csharp} text="Cs" />,
  fs:    (s) => <Chip size={s} bg={C.fsharp} text="F#" />,
  fsx:   (s) => <Chip size={s} bg={C.fsharp} text="F#" />,
  php:   (s) => <Chip size={s} bg={C.php} text="Ph" />,
  lua:   (s) => <Chip size={s} bg={C.lua} text="Lu" />,
  dart:  (s) => <Chip size={s} bg={C.dart} text="Dt" />,
  ex:    (s) => <Chip size={s} bg={C.elixir} text="Ex" />,
  exs:   (s) => <Chip size={s} bg={C.elixir} text="Ex" />,
  erl:   (s) => <Chip size={s} bg={C.erlang} text="Er" />,
  hrl:   (s) => <Chip size={s} bg={C.erlang} text="Er" />,
  hs:    (s) => <Chip size={s} bg={C.haskell} text="Hs" />,
  lhs:   (s) => <Chip size={s} bg={C.haskell} text="Hs" />,
  ml:    (s) => <Chip size={s} bg={C.ocaml} text="Ml" />,
  mli:   (s) => <Chip size={s} bg={C.ocaml} text="Ml" />,
  clj:   (s) => <Chip size={s} bg={C.clojure} text="Cj" />,
  cljs:  (s) => <Chip size={s} bg={C.clojure} text="Cj" />,
  cljc:  (s) => <Chip size={s} bg={C.clojure} text="Cj" />,
  edn:   (s) => <Chip size={s} bg={C.clojure} text="Ed" />,
  pl:    (s) => <Chip size={s} bg={C.perl} text="Pl" />,
  pm:    (s) => <Chip size={s} bg={C.perl} text="Pl" />,
  r:     (s) => <Chip size={s} bg={C.r} text="R" />,
  rmd:   (s) => <Chip size={s} bg={C.r} text="Rm" />,
  jl:    (s) => <Chip size={s} bg={C.julia} text="Jl" />,
  nim:   (s) => <Chip size={s} bg={C.nim} text="Nm" />,
  zig:   (s) => <Chip size={s} bg={C.zig} text="Zg" />,
  d:     (s) => <Chip size={s} bg={C.cpp} text="D" />,
  groovy:(s) => <Chip size={s} bg={C.groovy} text="Gv" />,
  gd:    (s) => <Chip size={s} bg={C.config} text="Gd" />, // Godot
  v:     (s) => <Chip size={s} bg={C.go} text="V" />,
  vala:  (s) => <Chip size={s} bg={C.config} text="Vl" />,
  cr:    (s) => <Chip size={s} bg={C.ruby} text="Cr" />, // Crystal

  // Shell / scripting
  sh:    (s) => <Chip size={s} bg={C.shell} text=">_" />,
  zsh:   (s) => <Chip size={s} bg={C.shell} text=">_" />,
  bash:  (s) => <Chip size={s} bg={C.shell} text=">_" />,
  fish:  (s) => <Chip size={s} bg={C.shell} text=">_" />,
  ksh:   (s) => <Chip size={s} bg={C.shell} text=">_" />,
  ps1:   (s) => <Chip size={s} bg={C.config} text="Ps" />, // PowerShell
  psm1:  (s) => <Chip size={s} bg={C.config} text="Ps" />,
  bat:   (s) => <LineIcon size={s} color={C.shell} Component={FileTextIcon} />,
  cmd:   (s) => <LineIcon size={s} color={C.shell} Component={FileTextIcon} />,
  awk:   (s) => <Chip size={s} bg={C.shell} text="Aw" />,
  sed:   (s) => <Chip size={s} bg={C.shell} text="Sd" />,

  // Web / markup
  html:  (s) => <LineIcon size={s} color={C.html} Component={FileHtmlIcon} />,
  htm:   (s) => <LineIcon size={s} color={C.html} Component={FileHtmlIcon} />,
  xhtml: (s) => <LineIcon size={s} color={C.html} Component={FileHtmlIcon} />,
  css:   (s) => <LineIcon size={s} color={C.css} Component={FileCssIcon} />,
  scss:  (s) => <LineIcon size={s} color={C.css} Component={FileCssIcon} />,
  sass:  (s) => <LineIcon size={s} color={C.css} Component={FileCssIcon} />,
  less:  (s) => <LineIcon size={s} color={C.css} Component={FileCssIcon} />,
  styl:  (s) => <LineIcon size={s} color={C.css} Component={FileCssIcon} />,
  pcss:  (s) => <LineIcon size={s} color={C.css} Component={FileCssIcon} />,
  vue:   (s) => <Chip size={s} bg={C.vue} text="Vu" />,
  svelte:(s) => <Chip size={s} bg={C.svelte} text="Sv" />,
  astro: (s) => <Chip size={s} bg={C.config} text="As" />,
  pug:   (s) => <Chip size={s} bg={C.html} text="Pg" />,
  jade:  (s) => <Chip size={s} bg={C.html} text="Pg" />,
  ejs:   (s) => <Chip size={s} bg={C.html} text="Ej" />,
  hbs:   (s) => <Chip size={s} bg={C.html} text="Hb" />,
  handlebars:(s) => <Chip size={s} bg={C.html} text="Hb" />,
  mustache:(s) => <Chip size={s} bg={C.html} text="Mu" />,
  twig:  (s) => <Chip size={s} bg={C.html} text="Tw" />,
  liquid:(s) => <Chip size={s} bg={C.html} text="Lq" />,
  haml:  (s) => <Chip size={s} bg={C.ruby} text="Hm" />,
  slim:  (s) => <Chip size={s} bg={C.ruby} text="Sl" />,

  // Data
  json:  (s) => <LineIcon size={s} color={C.json} Component={FileCodeIcon} />,
  jsonc: (s) => <LineIcon size={s} color={C.json} Component={FileCodeIcon} />,
  json5: (s) => <LineIcon size={s} color={C.json} Component={FileCodeIcon} />,
  yaml:  (s) => <LineIcon size={s} color={C.yaml} Component={GearIcon} />,
  yml:   (s) => <LineIcon size={s} color={C.yaml} Component={GearIcon} />,
  toml:  (s) => <LineIcon size={s} color={C.toml} Component={GearIcon} />,
  xml:   (s) => <Chip size={s} bg={C.xml} text="<>" />,
  sql:   (s) => <LineIcon size={s} color={C.sql} Component={FileSqlIcon} />,
  prisma:(s) => <Chip size={s} bg={C.config} text="Pr" />,
  graphql:(s)=> <Chip size={s} bg={C.svelte} text="Gq" />,
  gql:   (s) => <Chip size={s} bg={C.svelte} text="Gq" />,
  proto: (s) => <Chip size={s} bg={C.config} text="Pb" />,
  avro:  (s) => <Chip size={s} bg={C.config} text="Av" />,
  csv:   (s) => <LineIcon size={s} color={C.json} Component={FileTextIcon} />,
  tsv:   (s) => <LineIcon size={s} color={C.json} Component={FileTextIcon} />,
  parquet:(s)=> <LineIcon size={s} color={C.json} Component={FileTextIcon} />,
  md:    (s) => <MarkdownBadge size={s} />,
  mdx:   (s) => <MarkdownBadge size={s} />,
  rst:   (s) => <MarkdownBadge size={s} />,
  txt:   (s) => <LineIcon size={s} color={C.text} Component={FileTextIcon} />,
  log:   (s) => <LineIcon size={s} color={C.text} Component={FileTextIcon} />,
  diff:  (s) => <Chip size={s} bg={C.git} text="Df" />,
  patch: (s) => <Chip size={s} bg={C.git} text="Df" />,

  // Configs
  lock:        (s) => <LineIcon size={s} color={C.lock} Component={LockIcon} />,
  gitignore:   (s) => <LineIcon size={s} color={C.git} Component={GitBranchIcon} />,
  gitattributes:(s)=> <LineIcon size={s} color={C.git} Component={GitBranchIcon} />,
  env:         (s) => <LineIcon size={s} color={C.env} Component={GearIcon} />,
  ini:         (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  conf:        (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  cfg:         (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  properties:  (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  // Infrastructure / build
  tf:          (s) => <Chip size={s} bg={C.kotlin} text="Tf" />, // Terraform
  tfvars:      (s) => <Chip size={s} bg={C.kotlin} text="Tf" />,
  hcl:         (s) => <Chip size={s} bg={C.kotlin} text="Tf" />,
  gradle:      (s) => <Chip size={s} bg={C.gradle} text="Gr" />,
  pom:         (s) => <Chip size={s} bg={C.maven} text="Mv" />,
  mk:          (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  cmake:       (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,
  ninja:       (s) => <LineIcon size={s} color={C.config} Component={GearIcon} />,

  // Images / media
  png:   (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  jpg:   (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  jpeg:  (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  gif:   (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  webp:  (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  avif:  (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  svg:   (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  ico:   (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  bmp:   (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  tiff:  (s) => <LineIcon size={s} color={C.image} Component={ImageIcon} />,
  pdf:   (s) => <Chip size={s} bg={C.pdf} text="Pd" />,
  mp4:   (s) => <Chip size={s} bg={C.video} text="Vd" />,
  mov:   (s) => <Chip size={s} bg={C.video} text="Vd" />,
  webm:  (s) => <Chip size={s} bg={C.video} text="Vd" />,
  avi:   (s) => <Chip size={s} bg={C.video} text="Vd" />,
  mkv:   (s) => <Chip size={s} bg={C.video} text="Vd" />,
  mp3:   (s) => <Chip size={s} bg={C.audio} text="Au" />,
  wav:   (s) => <Chip size={s} bg={C.audio} text="Au" />,
  flac:  (s) => <Chip size={s} bg={C.audio} text="Au" />,
  ogg:   (s) => <Chip size={s} bg={C.audio} text="Au" />,

  // Archives
  zip:   (s) => <Chip size={s} bg={C.archive} text="Zp" />,
  gz:    (s) => <Chip size={s} bg={C.archive} text="Gz" />,
  tar:   (s) => <Chip size={s} bg={C.archive} text="Tr" />,
  tgz:   (s) => <Chip size={s} bg={C.archive} text="Tr" />,
  bz2:   (s) => <Chip size={s} bg={C.archive} text="Bz" />,
  xz:    (s) => <Chip size={s} bg={C.archive} text="Xz" />,
  rar:   (s) => <Chip size={s} bg={C.archive} text="Rr" />,
  "7z":  (s) => <Chip size={s} bg={C.archive} text="7z" />,

  // Crypto / keys
  pem:   (s) => <LineIcon size={s} color={C.key} Component={LockIcon} />,
  key:   (s) => <LineIcon size={s} color={C.key} Component={LockIcon} />,
  crt:   (s) => <LineIcon size={s} color={C.key} Component={LockIcon} />,
  cer:   (s) => <LineIcon size={s} color={C.key} Component={LockIcon} />,
  pub:   (s) => <LineIcon size={s} color={C.key} Component={LockIcon} />,
  gpg:   (s) => <LineIcon size={s} color={C.key} Component={LockIcon} />,
  asc:   (s) => <LineIcon size={s} color={C.key} Component={LockIcon} />,
};

/* ------------------------------------------------------------------
   Public API
   ------------------------------------------------------------------ */

/**
 * Lightweight descriptor for callers that want to know the file's
 * general kind without rendering. The richer per-type rendering
 * lives in <FileTypeIcon>. Returns a stable shape so consumers can
 * compose it freely.
 */
export function fileTypeFor(name: string): { glyph: string; color: string } {
  const lower = name.toLowerCase();
  if (/^Dockerfile(\.|$)/i.test(name)) return { glyph: "Dk", color: C.docker };
  if (/^tsconfig(\..+)?\.json$/i.test(name)) return { glyph: "TS", color: C.ts };
  if (/\.tsbuildinfo$/i.test(name)) return { glyph: "TS", color: C.ts };
  if (/\.d\.ts$/i.test(name)) return { glyph: "DT", color: C.ts };
  const ext = lower.split(".").pop() ?? "";
  if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts")
    return { glyph: "TS", color: C.ts };
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs")
    return { glyph: "JS", color: C.js };
  if (ext === "rs") return { glyph: "Rs", color: C.rust };
  if (ext === "py" || ext === "ipynb") return { glyph: "Py", color: C.python };
  if (ext === "go") return { glyph: "Go", color: C.go };
  if (ext === "rb") return { glyph: "Rb", color: C.ruby };
  if (ext === "md" || ext === "mdx") return { glyph: "Md", color: C.markdown };
  if (ext === "json" || ext === "jsonc" || ext === "json5")
    return { glyph: "JSN", color: C.json };
  return { glyph: "·", color: "var(--text-tertiary)" };
}

export function FileTypeIcon({
  name,
  isDir,
  open = false,
  size = 14,
  style,
}: Props) {
  if (isDir) return <FolderGlyph open={open} size={size} style={style} />;

  // Whole-filename match first (Dockerfile, package.json, etc.).
  // Lowercased so case variations all hit.
  const exact = FILENAME_RENDERERS[name.toLowerCase()];
  if (exact) return <span style={style}>{exact(size)}</span>;

  // Pattern matches (Dockerfile.dev, tsconfig.app.json, *.d.ts, etc.).
  for (const { pattern, render } of FILENAME_PATTERNS) {
    if (pattern.test(name)) return <span style={style}>{render(size)}</span>;
  }

  // Extension fallthrough.
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const byExt = EXT_RENDERERS[ext];
  if (byExt) return <span style={style}>{byExt(size)}</span>;

  // Final fallback — quiet outlined neutral document.
  return <DocumentOutline size={size} style={style} />;
}

/**
 * Fallback for unknown file types: a thin outlined document with a
 * folded corner. Neutral grey so it doesn't compete with the typed
 * icons around it.
 */
function DocumentOutline({
  size,
  style,
}: {
  size: number;
  style?: CSSProperties;
}) {
  const color = "var(--text-tertiary)";
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color,
        ...style,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        style={{ display: "block", transform: `scale(${LINE_ICON_SCALE})` }}
      >
        <path
          d="M3.5 2.5h5.6L12.5 5.9V12.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z"
          stroke="currentColor"
          strokeWidth={1.2 / LINE_ICON_SCALE}
          opacity="0.75"
        />
        <path
          d="M9 2.5V6h3.5"
          stroke="currentColor"
          strokeWidth={1.2 / LINE_ICON_SCALE}
          opacity="0.55"
        />
      </svg>
    </span>
  );
}

function FolderGlyph({
  open,
  size,
  style,
}: {
  open: boolean;
  size: number;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: open ? "var(--accent)" : "var(--text-tertiary)",
        ...style,
      }}
      aria-hidden
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        style={{ display: "block", transform: `scale(${LINE_ICON_SCALE})` }}
      >
        {open ? (
          <path
            d="M2 5.5C2 4.7 2.7 4 3.5 4h2.4c.4 0 .7.1 1 .4l1.2 1.1H12.5c.8 0 1.5.7 1.5 1.5v.5H4.6c-.6 0-1.2.4-1.4 1L2 12V5.5Z"
            fill="currentColor"
            opacity="0.85"
          />
        ) : (
          <path
            d="M2 5.5C2 4.7 2.7 4 3.5 4h2.4c.4 0 .7.1 1 .4l1.2 1.1H12.5c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5V5.5Z"
            fill="currentColor"
            opacity="0.7"
          />
        )}
      </svg>
    </span>
  );
}

