import { useEffect, useRef, useState } from "react";
import { useAppDispatch } from "@/state/AppState";
import type { TodoItem, Worktree } from "@/state/types";

type View = "todos" | "history";

/**
 * Right-panel "Todo" pane. A single inline checklist — no separate
 * composer box. Click anywhere empty to create a todo and start typing;
 * press Enter to spin off the next one; Backspace on an empty item
 * deletes it. The circular checkbox cycles todo → in_progress → done;
 * done items drop out of the list and into History.
 *
 * A small "Todos / History" toggle sits at the top. Both the active list
 * (`worktree.todos`) and the completed archive (`worktree.todoHistory`)
 * are written back with the generic `update-worktree` action, so they
 * persist with the worktree exactly like `prSession` — survive relaunch,
 * no extra plumbing.
 */
export function TodoView({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();
  const todos = worktree.todos ?? [];
  const history = worktree.todoHistory ?? [];
  const [view, setView] = useState<View>("todos");

  // Which row to focus after the next render. Set by add/delete actions;
  // consumed by the effect once React has committed the new list to the
  // DOM (the dispatch round-trips through the store, so the input for a
  // freshly-added id doesn't exist until the re-render).
  const [focusId, setFocusId] = useState<string | null>(null);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    if (!focusId) return;
    const el = inputRefs.current.get(focusId);
    if (el) {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
    setFocusId(null);
  }, [focusId, todos]);

  const patch = (p: Partial<Worktree>) => {
    dispatch({ type: "update-worktree", id: worktree.id, patch: p });
  };

  const makeItem = (): TodoItem => ({
    id: `todo_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`,
    text: "",
    status: "todo",
    createdAt: Date.now(),
  });

  const addAtEnd = () => {
    const item = makeItem();
    patch({ todos: [...todos, item] });
    setFocusId(item.id);
  };

  const insertAfter = (id: string) => {
    const idx = todos.findIndex((t) => t.id === id);
    const item = makeItem();
    const next = [...todos];
    next.splice(idx + 1, 0, item);
    patch({ todos: next });
    setFocusId(item.id);
  };

  const setText = (id: string, text: string) => {
    patch({ todos: todos.map((t) => (t.id === id ? { ...t, text } : t)) });
  };

  // Circle click cycles the state: todo → in_progress → done. Reaching
  // "done" pulls the item out of the active list and pushes it to the
  // front of history (empty items are just discarded, not archived).
  const cycle = (id: string) => {
    const cur = todos.find((t) => t.id === id);
    if (!cur) return;
    if (cur.status === "todo") {
      patch({
        todos: todos.map((t) =>
          t.id === id ? { ...t, status: "in_progress" } : t,
        ),
      });
      return;
    }
    const remaining = todos.filter((t) => t.id !== id);
    if (cur.text.trim() === "") {
      patch({ todos: remaining });
      return;
    }
    const done: TodoItem = {
      ...cur,
      status: "done",
      completedAt: Date.now(),
    };
    patch({ todos: remaining, todoHistory: [done, ...history] });
  };

  const remove = (id: string, focusPrev: boolean) => {
    const idx = todos.findIndex((t) => t.id === id);
    patch({ todos: todos.filter((t) => t.id !== id) });
    if (focusPrev && idx > 0) setFocusId(todos[idx - 1].id);
  };

  const focusSibling = (id: string, dir: 1 | -1) => {
    const idx = todos.findIndex((t) => t.id === id);
    const next = todos[idx + dir];
    if (next) setFocusId(next.id);
  };

  // Send a completed item back to the active list from History.
  const restore = (id: string) => {
    const cur = history.find((t) => t.id === id);
    if (!cur) return;
    const revived: TodoItem = { ...cur, status: "todo", completedAt: undefined };
    patch({
      todos: [...todos, revived],
      todoHistory: history.filter((t) => t.id !== id),
    });
    setView("todos");
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-1)",
      }}
    >
      {/* Todos / History toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 32,
          padding: "0 var(--space-2)",
          borderBottom: "var(--border-1)",
          flexShrink: 0,
        }}
      >
        <SegTab
          label="Todos"
          active={view === "todos"}
          onClick={() => setView("todos")}
        />
        <SegTab
          label="History"
          count={history.length}
          active={view === "history"}
          onClick={() => setView("history")}
        />
        {view === "history" && history.length > 0 && (
          <button
            type="button"
            onClick={() => patch({ todoHistory: [] })}
            title="Clear all completed items"
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "none",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-2xs)",
              cursor: "pointer",
              padding: "2px 4px",
              transition: "color var(--motion-fast) var(--ease-out-quart)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "var(--text-primary)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "var(--text-tertiary)")
            }
          >
            Clear
          </button>
        )}
      </div>

      {view === "todos" ? (
        // Click anywhere in the scroll region (including the empty area
        // below the rows) to append a new todo and focus it.
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) addAtEnd();
          }}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: "var(--space-2) 0",
            cursor: "text",
          }}
        >
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {todos.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                registerRef={(el) => {
                  if (el) inputRefs.current.set(todo.id, el);
                  else inputRefs.current.delete(todo.id);
                }}
                onChangeText={(text) => setText(todo.id, text)}
                onCycle={() => cycle(todo.id)}
                onEnter={() => insertAfter(todo.id)}
                onDeleteEmpty={() => remove(todo.id, true)}
                onArrow={(dir) => focusSibling(todo.id, dir)}
              />
            ))}
          </ul>

          {todos.length === 0 && (
            <div
              onClick={addAtEnd}
              style={{
                padding: "6px var(--space-3)",
                color: "var(--text-tertiary)",
                fontSize: "var(--text-sm)",
                cursor: "text",
              }}
            >
              Click to add a todo…
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {history.length === 0 ? (
            <div
              style={{
                padding: "var(--space-4)",
                color: "var(--text-tertiary)",
                fontSize: "var(--text-xs)",
              }}
            >
              No completed todos yet.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {history.map((todo) => (
                <HistoryRow
                  key={todo.id}
                  todo={todo}
                  onRestore={() => restore(todo.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SegTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 22,
        padding: "0 8px",
        borderRadius: "var(--radius-xs)",
        border: "none",
        cursor: "pointer",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: "var(--text-xs)",
        fontWeight: active ? "var(--weight-medium)" : "var(--weight-regular)",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className="tabular"
          style={{
            fontSize: "var(--text-2xs)",
            color: active ? "var(--text-secondary)" : "var(--text-disabled)",
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function TodoRow({
  todo,
  registerRef,
  onChangeText,
  onCycle,
  onEnter,
  onDeleteEmpty,
  onArrow,
}: {
  todo: TodoItem;
  registerRef: (el: HTMLInputElement | null) => void;
  onChangeText: (text: string) => void;
  onCycle: () => void;
  onEnter: () => void;
  onDeleteEmpty: () => void;
  onArrow: (dir: 1 | -1) => void;
}) {
  const [hover, setHover] = useState(false);
  const inProgress = todo.status === "in_progress";

  return (
    <li>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "3px var(--space-3)",
          backgroundColor: hover ? "var(--surface-2)" : "transparent",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
      >
        <button
          type="button"
          aria-label={inProgress ? "Mark as done" : "Mark as in progress"}
          title={inProgress ? "In progress — click to complete" : "Start"}
          onClick={onCycle}
          style={circleButtonStyle}
        >
          <StatusCircle status={todo.status} />
        </button>

        <input
          ref={registerRef}
          value={todo.text}
          onChange={(e) => onChangeText(e.target.value)}
          placeholder="Todo"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter();
            } else if (e.key === "Backspace" && todo.text === "") {
              e.preventDefault();
              onDeleteEmpty();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onArrow(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              onArrow(-1);
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            outline: "none",
            padding: 0,
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            color: "var(--text-primary)",
          }}
        />
      </div>
    </li>
  );
}

function HistoryRow({
  todo,
  onRestore,
}: {
  todo: TodoItem;
  onRestore: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <li>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "3px var(--space-3)",
          backgroundColor: hover ? "var(--surface-2)" : "transparent",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
      >
        <button
          type="button"
          onClick={onRestore}
          aria-label="Bring back to Todos"
          title="Click to bring back to Todos"
          style={circleButtonStyle}
        >
          <StatusCircle status="done" />
        </button>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-sm)",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {todo.text}
        </span>
        {todo.completedAt !== undefined && (
          <span
            className="tabular"
            style={{
              flexShrink: 0,
              fontSize: "var(--text-2xs)",
              color: "var(--text-disabled)",
            }}
          >
            {formatWhen(todo.completedAt)}
          </span>
        )}
      </div>
    </li>
  );
}

const circleButtonStyle = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  padding: 0,
  border: "none",
  background: "transparent",
  cursor: "pointer",
} as const;

/**
 * The circular status marker. Empty ring for "todo"; a yellow ring with
 * a half-filled pie (the classic issue-tracker "in progress" glyph) once
 * started; a filled green circle with a check for "done". Drawn as inline
 * SVG so every state shares exact geometry.
 */
function StatusCircle({ status }: { status: TodoItem["status"] }) {
  if (status === "done") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="var(--state-success)" />
        <path
          d="M4.6 8.3 L7 10.6 L11.4 5.6"
          fill="none"
          stroke="var(--surface-1)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  const inProgress = status === "in_progress";
  const color = inProgress ? "var(--state-warning)" : "var(--border-strong)";
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke={color} strokeWidth="1.5" />
      {inProgress && (
        // Right-half pie from top → bottom, filled yellow.
        <path
          d="M8 8 L8 1.75 A6.25 6.25 0 0 1 8 14.25 Z"
          fill="var(--state-warning)"
        />
      )}
    </svg>
  );
}

/** Compact relative time: "now", "5m", "3h", "2d", else a short date. */
function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
