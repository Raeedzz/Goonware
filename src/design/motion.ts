/**
 * Goonware motion language — Motion (Framer Motion v12+) variants & transitions.
 *
 * See design-system/motion.md for the rationale and choreography spec.
 *
 * Hard rules baked in:
 *   1. Animate transform + opacity only.
 *   2. Default duration 150ms, default easing ease-out-quart.
 *   3. Exit ≈ 75% of entrance.
 *   4. Springs ONLY for the active-tab indicator and the active-project strip.
 *      Everything else uses deterministic curves.
 *   5. prefers-reduced-motion → strip transforms, clamp durations to 80ms.
 *
 * Components consume these variants like:
 *
 *   <motion.div variants={paletteVariants} initial="hidden" animate="visible" exit="exit" />
 *
 * For the tab indicator, use the shared LAYOUT_TAB_INDICATOR constant:
 *
 *   <motion.div layoutId={LAYOUT_TAB_INDICATOR} transition={tabIndicatorSpring} />
 */

import type { Transition, Variants } from "motion/react";
import { useReducedMotion } from "motion/react";

/* ------------------------------------------------------------------
   Easing curves — mirror tokens.css
   ------------------------------------------------------------------ */

export const ease = {
  outQuart:  [0.25, 1, 0.5, 1] as const,
  outQuint:  [0.22, 1, 0.36, 1] as const,
  inQuart:   [0.5, 0, 0.75, 0] as const,
  inOut:     [0.65, 0, 0.35, 1] as const,
};

/* ------------------------------------------------------------------
   Durations — mirror tokens.css (in seconds, since Motion uses seconds)
   ------------------------------------------------------------------ */

export const dur = {
  instant: 0.10,
  fast:    0.15,
  base:    0.20,
  slow:    0.28,
  slower:  0.40,

  exitFast: 0.11,
  exitBase: 0.15,
  exitSlow: 0.21,
};

/* ------------------------------------------------------------------
   Reusable transitions
   ------------------------------------------------------------------ */

export const t = {
  fast:      { duration: dur.fast,    ease: ease.outQuart } as Transition,
  base:      { duration: dur.base,    ease: ease.outQuart } as Transition,
  slow:      { duration: dur.slow,    ease: ease.outQuart } as Transition,
  slower:    { duration: dur.slower,  ease: ease.outQuart } as Transition,

  exitFast:  { duration: dur.exitFast, ease: ease.inQuart } as Transition,
  exitBase:  { duration: dur.exitBase, ease: ease.inQuart } as Transition,
  exitSlow:  { duration: dur.exitSlow, ease: ease.inQuart } as Transition,

  /** The hero spring — shared between tab indicator and project rail strip. */
  hero: {
    type: "spring",
    stiffness: 380,
    damping: 32,
    mass: 0.8,
  } as Transition,

  /** Soft, springless settle for layout reorders (tabs, toasts). */
  layout: { duration: dur.base, ease: ease.outQuart } as Transition,
};

/* ------------------------------------------------------------------
   Shared layoutId constants
   ------------------------------------------------------------------ */

export const LAYOUT_TAB_INDICATOR    = "goonware-active-tab";
export const LAYOUT_PROJECT_STRIP    = "goonware-active-project";

/* ------------------------------------------------------------------
   Surface variants
   ------------------------------------------------------------------ */

/** Command palette container. Mounts centered, slight rise + scale. */
export const paletteVariants: Variants = {
  hidden:  { opacity: 0, y: -6, scale: 0.985 },
  visible: { opacity: 1, y: 0,  scale: 1, transition: t.base },
  exit:    { opacity: 0, y: -4, scale: 0.99, transition: t.exitBase },
};

/** Backdrop for any centered overlay (palette, modal). */
export const backdropVariants: Variants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.12, ease: ease.outQuart } },
  exit:    { opacity: 0, transition: { duration: 0.10, ease: ease.inQuart } },
};

/** Modal / dialog (session close prompt). */
export const modalVariants: Variants = {
  hidden:  { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: { duration: dur.slow, ease: ease.outQuart } },
  exit:    { opacity: 0, scale: 0.98, transition: { duration: dur.exitBase, ease: ease.inQuart } },
};

/** Connections view — slides in from the right column edge. */
export const connectionsViewVariants: Variants = {
  hidden:  { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.24, ease: ease.outQuart } },
  exit:    { opacity: 0, x: 16, transition: { duration: 0.18, ease: ease.inQuart } },
};

/** Highlight-and-ask margin annotation card. */
export const marginCardVariants: Variants = {
  hidden:  { opacity: 0, x: 16 },
  visible: { opacity: 1, x: 0, transition: { duration: dur.base, ease: ease.outQuart } },
  exit:    { opacity: 0, x: 8, transition: { duration: 0.14, ease: ease.inQuart } },
};

/** Toast — slides in from the right edge of the viewport. */
export const toastVariants: Variants = {
  hidden:  { opacity: 0, x: 20 },
  visible: { opacity: 1, x: 0, transition: { duration: dur.slow, ease: ease.outQuart } },
  exit:    { opacity: 0, x: 20, transition: { duration: 0.18, ease: ease.inQuart } },
};

/** Dropdown / popover — quick fade + 2px rise. */
export const dropdownVariants: Variants = {
  hidden:  { opacity: 0, y: -2 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.12, ease: ease.outQuart } },
  exit:    { opacity: 0, y: -2, transition: { duration: 0.09, ease: ease.inQuart } },
};

/** Tooltip — fast fade only, no movement. */
export const tooltipVariants: Variants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.10, ease: ease.outQuart } },
  exit:    { opacity: 0, transition: { duration: 0.075, ease: ease.inQuart } },
};

/** New session tab spawning — width via grid-template-columns trick + opacity. */
export const tabSpawnVariants: Variants = {
  hidden:  { opacity: 0 /* width controlled by grid-template-columns parent */ },
  visible: { opacity: 1, transition: { duration: dur.slow, ease: ease.outQuart } },
  exit:    { opacity: 0, transition: { duration: 0.16, ease: ease.inQuart } },
};

/** Subtitle crossfade when tab summary updates. */
export const subtitleVariants: Variants = {
  enter:  { opacity: 0 },
  center: { opacity: 1, transition: { duration: dur.base, ease: ease.outQuart } },
  exit:   { opacity: 0, transition: { duration: 0.14, ease: ease.inQuart } },
};

/* ------------------------------------------------------------------
   The hero — tab indicator transition
   ------------------------------------------------------------------ */

/**
 * Use on the active-tab indicator element (a 2px top border on the active tab):
 *
 *   <motion.div
 *     layoutId={LAYOUT_TAB_INDICATOR}
 *     transition={tabIndicatorSpring}
 *     className="active-tab-strip"
 *   />
 *
 * The same spring is used on the project rail's left-edge strip.
 */
export const tabIndicatorSpring: Transition = t.hero;
export const projectStripSpring: Transition = t.hero;

/* ------------------------------------------------------------------
   Drag presets
   ------------------------------------------------------------------ */

/** Project icon while being dragged in the rail. */
export const projectDragLift = {
  scale: 1.03,
  transition: { duration: 0.12, ease: ease.outQuart },
};

/** Session tab while being dragged in the strip. */
export const tabDragLift = {
  scale: 1.02,
  transition: { duration: 0.12, ease: ease.outQuart },
};

/* ------------------------------------------------------------------
   Stagger helpers
   ------------------------------------------------------------------ */

/**
 * Container that staggers its children's appearance.
 * Use sparingly — only for genuinely-new lists, not for filters/searches.
 * Capped at 8 items × 30ms = 240ms total.
 */
export const staggerContainer: Variants = {
  hidden:  {},
  visible: {
    transition: { staggerChildren: 0.03, delayChildren: 0.03 },
  },
};

export const staggerChild: Variants = {
  hidden:  { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.18, ease: ease.outQuart } },
};

/* ------------------------------------------------------------------
   Reduced-motion overrides
   ------------------------------------------------------------------ */

/**
 * Strip transforms from a variant, leave only opacity, and clamp durations.
 * Use this in components via the useReducedVariants() hook below.
 */
function reduce(variants: Variants): Variants {
  const out: Variants = {};
  for (const key of Object.keys(variants) as (keyof Variants)[]) {
    const v = variants[key] as Record<string, unknown>;
    const reduced: Record<string, unknown> = {};
    if ("opacity" in v) reduced.opacity = v.opacity;
    // Drop x, y, scale, rotate. Keep transition but clamp duration.
    if (v.transition) {
      const tr = v.transition as Record<string, unknown>;
      reduced.transition = {
        ...tr,
        duration: Math.min((tr.duration as number) ?? 0.08, 0.08),
        ease: "linear",
        type: undefined, // strip springs
      };
    }
    out[key] = reduced as Variants[keyof Variants];
  }
  return out;
}

/**
 * Returns either the original variants or a reduced-motion-compliant
 * version, based on the user's prefers-reduced-motion setting.
 *
 * Usage:
 *   const variants = useReducedVariants(paletteVariants);
 */
export function useReducedVariants(variants: Variants): Variants {
  const shouldReduce = useReducedMotion();
  return shouldReduce ? reduce(variants) : variants;
}

/**
 * Returns the tab indicator transition, replacing the spring with an instant
 * jump for reduced-motion users.
 */
export function useTabIndicatorTransition(): Transition {
  const shouldReduce = useReducedMotion();
  return shouldReduce
    ? { duration: 0, ease: "linear" }
    : tabIndicatorSpring;
}

/* ------------------------------------------------------------------
   CSS class names — paired with motion.css
   ------------------------------------------------------------------ */

export const css = {
  pulse:        "goonware-pulse",        // streaming agent status dot
  loadingDots:  "goonware-loading-dots", // three-dot loading indicator
  pressDown:    "goonware-press",        // button :active scale-down
};
