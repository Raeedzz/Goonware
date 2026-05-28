import { useEffect, useMemo, useState } from "react";
import { useAppDispatch } from "@/state/AppState";
import type { Worktree } from "@/state/types";
import {
  claudeConfig,
  type McpEntry,
  type SkillEntry,
} from "@/lib/fs";
import { IconSearch } from "@/design/icons";

type Mode = "skills" | "mcps";

/**
 * Right-panel "Skills" pane. A segmented toggle at the top switches
 * between the user's installed skills and their MCP servers; a search
 * input filters the list under it. Clicking a skill opens its SKILL.md
 * as a markdown tab in the main column so the user can read what the
 * skill does without leaving Goonware.
 *
 * Data is pulled once on mount via two Tauri commands (`skills_list`,
 * `mcps_list`) which walk `~/.claude/skills` and the plugin cache.
 * Filtering / grouping is purely client-side.
 */
export function SkillsView({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();
  const [mode, setMode] = useState<Mode>("skills");
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [mcps, setMcps] = useState<McpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([claudeConfig.listSkills(), claudeConfig.listMcps()])
      .then(([s, m]) => {
        if (cancelled) return;
        setSkills(s);
        setMcps(m);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Lowercased query reused across filter calls in this render. Empty
  // query short-circuits the per-item check below.
  const q = query.trim().toLowerCase();

  const filteredSkills = useMemo(() => {
    if (!q) return skills;
    return skills.filter((s) => matchesSkill(s, q));
  }, [skills, q]);

  const filteredMcps = useMemo(() => {
    if (!q) return mcps;
    return mcps.filter((m) => matchesMcp(m, q));
  }, [mcps, q]);

  // Group filtered skills by source — "user" pinned first, plugins in
  // alpha order — so the list reads as "your stuff, then everything
  // else" rather than a soup keyed by random source names.
  const groupedSkills = useMemo(() => {
    const map = new Map<string, SkillEntry[]>();
    for (const s of filteredSkills) {
      const arr = map.get(s.source) ?? [];
      arr.push(s);
      map.set(s.source, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "user") return -1;
      if (b === "user") return 1;
      return a.localeCompare(b);
    });
  }, [filteredSkills]);

  const openSkill = (skill: SkillEntry) => {
    const id = `t_skill_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    dispatch({
      type: "open-tab",
      tab: {
        id,
        worktreeId: worktree.id,
        kind: "markdown",
        filePath: skill.path,
        mode: "preview",
        content: null,
        savedContent: null,
        title: skill.name,
        summary: `skill · ${skill.source}`,
        summaryUpdatedAt: Date.now(),
      },
    });
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: 0,
        height: "100%",
      }}
    >
      <Toolbar
        mode={mode}
        onModeChange={setMode}
        skillsCount={skills.length}
        mcpsCount={mcps.length}
        query={query}
        onQueryChange={setQuery}
      />

      <div style={{ minHeight: 0, overflow: "auto" }}>
        {loading ? (
          <EmptyMessage>Loading…</EmptyMessage>
        ) : error ? (
          <EmptyMessage tone="error">{error}</EmptyMessage>
        ) : mode === "skills" ? (
          filteredSkills.length === 0 ? (
            <EmptyMessage>
              {q ? `No skills match "${query}".` : "No skills installed."}
            </EmptyMessage>
          ) : (
            groupedSkills.map(([source, entries]) => (
              <section key={source}>
                <SectionHeader
                  label={source === "user" ? "Your skills" : source}
                  count={entries.length}
                />
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {entries.map((skill) => (
                    <SkillRow
                      key={skill.id}
                      skill={skill}
                      onOpen={openSkill}
                    />
                  ))}
                </ul>
              </section>
            ))
          )
        ) : filteredMcps.length === 0 ? (
          <EmptyMessage>
            {q
              ? `No MCP servers match "${query}".`
              : "No MCP servers configured."}
          </EmptyMessage>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {filteredMcps.map((mcp) => (
              <McpRow key={mcp.id} mcp={mcp} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   Toolbar — segmented Skill/MCP toggle + search input
   ------------------------------------------------------------------ */

function Toolbar({
  mode,
  onModeChange,
  skillsCount,
  mcpsCount,
  query,
  onQueryChange,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  skillsCount: number;
  mcpsCount: number;
  query: string;
  onQueryChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "var(--space-2) var(--space-2) var(--space-2)",
        borderBottom: "var(--border-1)",
        backgroundColor: "var(--surface-1)",
      }}
    >
      <div
        role="tablist"
        aria-label="View"
        style={{
          display: "flex",
          alignItems: "center",
          padding: 2,
          backgroundColor: "var(--surface-2)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
        }}
      >
        <SegmentButton
          active={mode === "skills"}
          onClick={() => onModeChange("skills")}
          label="Skills"
          count={skillsCount}
        />
        <SegmentButton
          active={mode === "mcps"}
          onClick={() => onModeChange("mcps")}
          label="MCPs"
          count={mcpsCount}
        />
      </div>

      <SearchInput
        value={query}
        onChange={onQueryChange}
        placeholder={mode === "skills" ? "Search skills…" : "Search MCPs…"}
      />
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        flex: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: 24,
        padding: "0 8px",
        borderRadius: "var(--radius-xs)",
        backgroundColor: active ? "var(--surface-4)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        fontWeight: active
          ? "var(--weight-semibold)"
          : "var(--weight-medium)",
        border: "none",
        cursor: "pointer",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (active) return;
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        if (active) return;
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      <span>{label}</span>
      <span
        className="tabular"
        style={{
          fontSize: "var(--text-2xs)",
          color: active ? "var(--text-secondary)" : "var(--text-disabled)",
          fontWeight: "var(--weight-regular)",
        }}
      >
        {count}
      </span>
    </button>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 8,
          display: "inline-flex",
          alignItems: "center",
          color: "var(--text-tertiary)",
          pointerEvents: "none",
        }}
      >
        <IconSearch size={12} />
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          height: 26,
          padding: "0 26px 0 26px",
          backgroundColor: "var(--surface-2)",
          color: "var(--text-primary)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          outline: "none",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--accent-muted)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "";
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          title="Clear"
          style={{
            position: "absolute",
            right: 4,
            width: 18,
            height: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-tertiary)",
            backgroundColor: "transparent",
            borderRadius: "var(--radius-xs)",
            fontSize: 12,
            lineHeight: 1,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
   Filtering — case-insensitive substring across the searchable fields
   ------------------------------------------------------------------ */

function matchesSkill(s: SkillEntry, q: string): boolean {
  return (
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.source.toLowerCase().includes(q)
  );
}

function matchesMcp(m: McpEntry, q: string): boolean {
  return (
    m.name.toLowerCase().includes(q) ||
    m.summary.toLowerCase().includes(q) ||
    m.source.toLowerCase().includes(q) ||
    m.kind.toLowerCase().includes(q)
  );
}

/* ------------------------------------------------------------------
   Row + section primitives
   ------------------------------------------------------------------ */

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 24,
        padding: "0 var(--space-3)",
        backgroundColor: "var(--surface-2)",
        borderBottom: "var(--border-1)",
      }}
    >
      <span
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          textTransform: "uppercase",
          letterSpacing: "var(--tracking-caps)",
          color: "var(--text-tertiary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span
        className="tabular"
        style={{
          marginLeft: 6,
          fontSize: "var(--text-2xs)",
          color: "var(--text-disabled)",
        }}
      >
        {count}
      </span>
    </div>
  );
}

function SkillRow({
  skill,
  onOpen,
}: {
  skill: SkillEntry;
  onOpen: (s: SkillEntry) => void;
}) {
  return (
    <li>
      <div
        onClick={() => onOpen(skill)}
        title={skill.description || skill.name}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: "8px var(--space-3)",
          color: "var(--text-primary)",
          backgroundColor: "transparent",
          cursor: "pointer",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseOver={(e) =>
          (e.currentTarget.style.backgroundColor = "var(--surface-2)")
        }
        onMouseOut={(e) =>
          (e.currentTarget.style.backgroundColor = "transparent")
        }
      >
        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-medium)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {skill.name}
        </span>
        {skill.description && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {skill.description}
          </span>
        )}
      </div>
    </li>
  );
}

function McpRow({ mcp }: { mcp: McpEntry }) {
  return (
    <li>
      <div
        title={mcp.summary || mcp.name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px var(--space-3)",
          color: "var(--text-primary)",
          fontSize: "var(--text-sm)",
        }}
      >
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {mcp.name}
        </span>
        <span
          className="tabular"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            padding: "1px 6px",
            borderRadius: "var(--radius-xs)",
            backgroundColor: "var(--surface-3)",
            border: "var(--border-1)",
          }}
        >
          {mcp.kind}
        </span>
        <span
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--text-disabled)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 120,
          }}
        >
          {mcp.source}
        </span>
      </div>
    </li>
  );
}

function EmptyMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        color:
          tone === "error" ? "var(--state-error)" : "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
      }}
    >
      {children}
    </div>
  );
}
