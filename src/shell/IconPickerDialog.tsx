import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "motion/react";
import { PICKER_ICONS, type PickerIcon } from "@/design/picker-icons";
import { TAG_IDS, type TagId } from "@/state/types";

interface Props {
  open: boolean;
  /** Display name in the title — also seeds the rename input. */
  targetName: string;
  /** Currently-selected icon name. */
  currentIcon?: string;
  /** Currently-selected color tag (TagId). */
  currentColor?: TagId;
  onSelectIcon: (iconName: string | undefined) => void;
  onSelectColor: (color: TagId | undefined) => void;
  onRename?: (newName: string) => void;
  onClose: () => void;
}

/**
 * Combined name / color / icon picker. Opens on double-click of any
 * sidebar row. Three sections, top-down:
 *
 *   1. Name input — type to rename, ↵ to commit, blur commits too.
 *   2. Color swatches — click to set the row's tag color.
 *   3. Icon grid — search + click to pick an iconName.
 *
 * Backdrop dismisses, ESC dismisses, clicks inside the panel never
 * bubble out. Each section commits independently so the user can
 * change just one thing without an extra "save" step.
 */
export function IconPickerDialog({
  open,
  targetName,
  currentIcon,
  currentColor,
  onSelectIcon,
  onSelectColor,
  onRename,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [draftName, setDraftName] = useState(targetName);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const backdropMouseDownRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDraftName(targetName);
      return;
    }
    setDraftName(targetName);
    // Renaming is the most common reason to open this dialog, so focus
    // the name input and pre-select its text — users can immediately
    // type a new label and hit Enter. Falls back to the icon search
    // when the row isn't renameable (e.g. read-only callers).
    const t = window.setTimeout(() => {
      if (onRename && nameRef.current) {
        nameRef.current.focus();
        nameRef.current.select();
      } else {
        inputRef.current?.focus();
      }
    }, 80);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, onRename, targetName]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PICKER_ICONS;
    return PICKER_ICONS.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.label.toLowerCase().includes(q),
    );
  }, [query]);

  const commitName = () => {
    if (!onRename) return;
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== targetName) onRename(trimmed);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="icon-picker-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget)
              backdropMouseDownRef.current = true;
          }}
          onMouseUp={(e) => {
            if (
              backdropMouseDownRef.current &&
              e.target === e.currentTarget
            ) {
              commitName();
              onClose();
            }
            backdropMouseDownRef.current = false;
          }}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--backdrop)",
            zIndex: 10_000,
            display: "grid",
            placeItems: "start center",
            paddingTop: "min(15vh, 140px)",
          }}
        >
          <motion.div
            key="icon-picker-panel"
            initial={{ opacity: 0, scale: 0.985, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 92vw)",
              maxHeight: "78vh",
              display: "grid",
              gridTemplateRows: "auto auto auto auto 1fr",
              backgroundColor: "var(--surface-2)",
              border: "var(--border-1)",
              borderRadius: "var(--radius-lg)",
              boxShadow:
                "0 24px 60px -16px rgba(0,0,0,0.65), 0 4px 10px rgba(0,0,0,0.4)",
              overflow: "hidden",
            }}
          >
            <header
              style={{
                padding: "var(--space-3) var(--space-4) var(--space-2)",
                display: "grid",
                gap: 6,
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-caps)",
                  color: "var(--text-tertiary)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                Customize
              </span>
              {onRename ? (
                <input
                  ref={nameRef}
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitName();
                      (e.currentTarget as HTMLInputElement).blur();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setDraftName(targetName);
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  style={{
                    width: "100%",
                    height: 40,
                    padding: "0 12px",
                    backgroundColor: "var(--surface-1)",
                    border: "var(--border-1)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-sans)",
                    fontSize: "var(--text-lg)",
                    fontWeight: "var(--weight-semibold)",
                    outline: "none",
                  }}
                />
              ) : (
                <span
                  style={{
                    fontSize: "var(--text-lg)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-primary)",
                  }}
                >
                  {targetName}
                </span>
              )}
            </header>

            <section
              style={{
                padding: "var(--space-3) var(--space-4)",
                borderTop: "var(--border-1)",
                display: "grid",
                gap: 6,
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-caps)",
                  color: "var(--text-tertiary)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                Color
              </span>
              <div
                role="radiogroup"
                aria-label="Tag color"
                style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
              >
                {TAG_IDS.map((id) => (
                  <ColorSwatch
                    key={id}
                    id={id}
                    active={id === (currentColor ?? "default")}
                    onClick={() =>
                      onSelectColor(id === "default" ? undefined : id)
                    }
                  />
                ))}
              </div>
            </section>

            <section
              style={{
                padding: "var(--space-3) var(--space-4) var(--space-2)",
                borderTop: "var(--border-1)",
                display: "grid",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-caps)",
                  color: "var(--text-tertiary)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                Icon
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  height: 40,
                  padding: "0 12px",
                  backgroundColor: "var(--surface-1)",
                  border: "var(--border-1)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <SearchGlyph />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search icons"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-sans)",
                    fontSize: "var(--text-md)",
                  }}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    title="Clear search"
                    style={{
                      width: 20,
                      height: 20,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "transparent",
                      color: "var(--text-tertiary)",
                      borderRadius: "var(--radius-xs)",
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </section>

            <div
              style={{
                overflow: "auto",
                padding: "0 var(--space-4) var(--space-4)",
                minHeight: 0,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))",
                  gap: 6,
                }}
              >
                {filtered.map((icon) => (
                  <IconCell
                    key={icon.name}
                    icon={icon}
                    active={icon.name === currentIcon}
                    onClick={() => onSelectIcon(icon.name)}
                  />
                ))}
                {filtered.length === 0 && (
                  <span
                    style={{
                      gridColumn: "1 / -1",
                      padding: "var(--space-4)",
                      textAlign: "center",
                      color: "var(--text-tertiary)",
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    No icons match "{query}"
                  </span>
                )}
              </div>

              {currentIcon && (
                <div
                  style={{
                    paddingTop: "var(--space-3)",
                    borderTop: "var(--border-1)",
                    marginTop: "var(--space-3)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelectIcon(undefined)}
                    style={{
                      height: 32,
                      padding: "0 14px",
                      backgroundColor: "transparent",
                      color: "var(--text-tertiary)",
                      border: "var(--border-1)",
                      borderRadius: "var(--radius-sm)",
                      fontSize: "var(--text-sm)",
                      cursor: "pointer",
                    }}
                  >
                    Reset to default
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function IconCell({
  icon,
  active,
  onClick,
}: {
  icon: PickerIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={icon.label}
      aria-label={icon.label}
      aria-pressed={active}
      style={{
        width: "100%",
        aspectRatio: "1 / 1",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? "var(--surface-accent-tinted)" : "transparent",
        color: active ? "var(--accent-bright)" : "var(--text-secondary)",
        border: active
          ? "1px solid var(--accent-muted)"
          : "1px solid transparent",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart), border-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (active) return;
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        if (active) return;
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--text-secondary)";
      }}
    >
      <icon.Component size={22} />
    </button>
  );
}

function ColorSwatch({
  id,
  active,
  onClick,
}: {
  id: TagId;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`color: ${id}`}
      title={id}
      onClick={onClick}
      style={{
        width: 32,
        height: 32,
        padding: 0,
        flexShrink: 0,
        borderRadius: "var(--radius-pill)",
        border: "none",
        backgroundColor: `var(--tag-${id})`,
        boxShadow: active
          ? "inset 0 0 0 2px oklch(0% 0 0 / 0.45), 0 0 0 2px var(--surface-2), 0 0 0 3px var(--accent)"
          : "inset 0 0 0 1px oklch(0% 0 0 / 0.25)",
        cursor: "pointer",
        transition:
          "transform 100ms var(--ease-out-quart), box-shadow 100ms var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "scale(1.08)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "scale(1)";
      }}
    />
  );
}

function SearchGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, color: "var(--text-tertiary)" }}
    >
      <circle
        cx="7"
        cy="7"
        r="4.4"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M10.4 10.4 L13 13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
