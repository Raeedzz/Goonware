/**
 * Goonware CodeMirror 6 theme.
 *
 * Calm, monochromatic-leaning syntax highlighting. Keywords use the info
 * blue (distinct from the accent steel blue), strings use sage green,
 * numbers use amber, types use the accent. Comments are tertiary text
 * + italic. Punctuation stays tertiary so structure quiets and content
 * (identifiers, strings) leads.
 *
 * Pairs with the xterm theme so the terminal and editor feel like the
 * same surface family.
 */

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Use CSS vars for surface tones so the editor tracks tokens.css —
// previously these were hardcoded hexes derived from older OKLCH values
// and had drifted (the old `surface0` was actually surface-1, leaving
// the editor a noticeable shade lighter than the terminal).
const COLORS = {
  surface0:    "var(--surface-0)",
  surface1:    "var(--surface-1)",
  surface2:    "var(--surface-2)",
  surface3:    "var(--surface-3)",

  borderHairline: "var(--border-hairline)",
  borderDefault:  "var(--border-default)",

  textPrimary:    "var(--text-primary)",
  textSecondary:  "var(--text-secondary)",
  textTertiary:   "var(--text-tertiary)",

  accent:         "var(--accent)",
  accentMuted:    "color-mix(in oklch, var(--surface-1), var(--accent) 22%)",

  stateInfo:      "var(--state-info)",
  stateSuccess:   "var(--state-success)",
  stateWarning:   "var(--state-warning)",
  stateError:     "var(--state-error)",
  stateInfoMuted: "color-mix(in oklch, var(--surface-1), var(--state-info) 18%)",
};

export const cm6Theme = EditorView.theme(
  {
    "&": {
      color: COLORS.textPrimary,
      backgroundColor: COLORS.surface0,
      fontSize: "13px",
      fontFamily:
        '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      height: "100%",
    },
    ".cm-content": {
      caretColor: COLORS.accent,
      fontVariantLigatures: "none",
      padding: "10px 0",
    },
    ".cm-line": {
      padding: "0 12px 0 4px",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: COLORS.accent,
      borderLeftWidth: "1px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: COLORS.accentMuted,
      },
    ".cm-gutters": {
      backgroundColor: COLORS.surface0,
      color: COLORS.textTertiary,
      borderRight: "none",
      paddingRight: "4px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: COLORS.textSecondary,
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.025)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 12px",
      fontVariantNumeric: "tabular-nums",
      minWidth: "2ch",
    },
    ".cm-foldGutter .cm-gutterElement": {
      color: COLORS.textTertiary,
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(212, 165, 88, 0.18)",
      outline: `1px solid ${COLORS.stateWarning}`,
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(212, 165, 88, 0.32)",
    },
    ".cm-tooltip": {
      backgroundColor: COLORS.surface3,
      color: COLORS.textPrimary,
      border: `1px solid ${COLORS.borderDefault}`,
      borderRadius: "6px",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
      fontSize: "12px",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: COLORS.accentMuted,
      color: COLORS.textPrimary,
    },
    ".cm-panels": {
      backgroundColor: COLORS.surface1,
      color: COLORS.textPrimary,
      borderTop: `1px solid ${COLORS.borderHairline}`,
    },
    ".cm-scroller": {
      overflow: "auto",
    },
  },
  { dark: true },
);

export const cm6Highlight = HighlightStyle.define([
  // Comments — quiet, italic
  { tag: t.comment, color: COLORS.textTertiary, fontStyle: "italic" },
  { tag: t.lineComment, color: COLORS.textTertiary, fontStyle: "italic" },
  { tag: t.blockComment, color: COLORS.textTertiary, fontStyle: "italic" },
  { tag: t.docComment, color: COLORS.textTertiary, fontStyle: "italic" },

  // Punctuation — quiet
  { tag: t.punctuation, color: COLORS.textTertiary },
  { tag: t.bracket, color: COLORS.textSecondary },
  { tag: t.brace, color: COLORS.textSecondary },
  { tag: t.paren, color: COLORS.textSecondary },
  { tag: t.separator, color: COLORS.textTertiary },

  // Identifiers — primary text, no special color
  { tag: t.variableName, color: COLORS.textPrimary },
  { tag: t.propertyName, color: COLORS.textPrimary },
  { tag: t.attributeName, color: COLORS.stateInfo },

  // Functions — medium weight, primary color
  { tag: t.function(t.variableName), color: COLORS.textPrimary, fontWeight: "500" },
  { tag: t.function(t.propertyName), color: COLORS.textPrimary, fontWeight: "500" },
  { tag: t.macroName, color: COLORS.textPrimary, fontWeight: "500" },

  // Keywords — info blue, distinct from accent
  { tag: t.keyword, color: COLORS.stateInfo, fontWeight: "500" },
  { tag: t.modifier, color: COLORS.stateInfo },
  { tag: t.controlKeyword, color: COLORS.stateInfo, fontWeight: "500" },
  { tag: t.operatorKeyword, color: COLORS.stateInfo },
  { tag: t.definitionKeyword, color: COLORS.stateInfo, fontWeight: "500" },
  { tag: t.moduleKeyword, color: COLORS.stateInfo, fontWeight: "500" },

  // Strings — sage green
  { tag: t.string, color: COLORS.stateSuccess },
  { tag: t.special(t.string), color: COLORS.stateSuccess },
  { tag: t.regexp, color: COLORS.stateWarning },
  { tag: t.escape, color: COLORS.stateWarning },

  // Numbers, atoms, booleans — amber
  { tag: t.number, color: COLORS.stateWarning },
  { tag: t.bool, color: COLORS.stateWarning },
  { tag: t.atom, color: COLORS.stateWarning },
  { tag: t.constant(t.variableName), color: COLORS.stateWarning },

  // Types & classes — accent
  { tag: t.typeName, color: COLORS.accent },
  { tag: t.className, color: COLORS.accent },
  { tag: t.namespace, color: COLORS.accent },

  // Operators
  { tag: t.operator, color: COLORS.textSecondary },
  { tag: t.compareOperator, color: COLORS.stateInfo },
  { tag: t.logicOperator, color: COLORS.stateInfo },
  { tag: t.arithmeticOperator, color: COLORS.textSecondary },

  // Tags & attributes (HTML/JSX)
  { tag: t.tagName, color: COLORS.stateError },
  { tag: t.angleBracket, color: COLORS.textTertiary },

  // Headings (markdown)
  { tag: t.heading, color: COLORS.textPrimary, fontWeight: "600" },
  { tag: t.heading1, color: COLORS.textPrimary, fontWeight: "700" },
  { tag: t.heading2, color: COLORS.textPrimary, fontWeight: "600" },
  { tag: t.link, color: COLORS.accent, textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },

  // Diff
  { tag: t.inserted, color: COLORS.stateSuccess },
  { tag: t.deleted, color: COLORS.stateError },
  { tag: t.changed, color: COLORS.stateWarning },

  // Invalid
  { tag: t.invalid, color: COLORS.stateError, textDecoration: "underline" },
]);

export const cm6ThemeExtension = [cm6Theme, syntaxHighlighting(cm6Highlight)];
