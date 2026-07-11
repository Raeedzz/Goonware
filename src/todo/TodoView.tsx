import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppDispatch } from "@/state/AppState";
import type { TodoItem, Worktree } from "@/state/types";

/**
 * Right-panel "Todo" pane. A single inline checklist — no separate
 * composer box. Click anywhere empty to create a todo and start typing;
 * press Enter to spin off the next one; Backspace on an empty item
 * deletes it. The circular checkbox cycles todo → in_progress → done;
 * done items drop out of the list and into History.
 *
 * Completed items live behind a "History" bar pinned to the bottom of the
 * pane. Clicking it expands a panel upward with every archived todo; click
 * again to collapse. Both the active list (`worktree.todos`) and the
 * completed archive (`worktree.todoHistory`) are written back with the
 * generic `update-worktree` action, so they persist with the worktree
 * exactly like `prSession` — survive relaunch, no extra plumbing.
 */
export function TodoView({ worktree }: { worktree: Worktree }) {
  const dispatch = useAppDispatch();
  const todos = worktree.todos ?? [];
  const history = worktree.todoHistory ?? [];
  const [historyOpen, setHistoryOpen] = useState(false);

  // Which row to focus after the next render. Set by add/delete actions;
  // consumed by the effect once React has committed the new list to the
  // DOM (the dispatch round-trips through the store, so the input for a
  // freshly-added id doesn't exist until the re-render).
  const [focusId, setFocusId] = useState<string | null>(null);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());

  // Always-fresh mirror of the persisted lists, read inside the deferred
  // "done" timeout below — the store may have changed (another todo added,
  // text edited) between the click and the timer firing, and the patch is a
  // shallow merge, so we must archive against the latest state, not a stale
  // closure captured at click time.
  const latest = useRef({ todos, history });
  latest.current = { todos, history };

  // Timers for todos flashing green before they drop into History, so we can
  // cancel them on unmount or worktree switch and avoid firing against a
  // dead component or archiving one worktree's id into another worktree.
  const doneTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useLayoutEffect(
    () => () => {
      doneTimers.current.forEach((t) => clearTimeout(t));
      doneTimers.current.clear();
    },
    [worktree.id],
  );

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

  // Move a "done" todo out of the active list and into History. Shared by
  // the 900ms flash timer below and the recovery sweep effect. Always reads
  // from — and synchronously advances — the `latest` mirror: if another
  // archive dispatches before React commits this one back into the
  // `worktree` prop, it must see this accumulated state, otherwise its
  // shallow-merge patch would clobber `todoHistory` and drop the item we
  // just archived.
  const archiveDone = (id: string) => {
    const { todos: curTodos, history: curHistory } = latest.current;
    const item = curTodos.find((t) => t.id === id);
    if (!item) return;
    const done: TodoItem = { ...item, status: "done", completedAt: Date.now() };
    const nextTodos = curTodos.filter((t) => t.id !== id);
    const nextHistory = [done, ...curHistory];
    latest.current = { todos: nextTodos, history: nextHistory };
    dispatch({
      type: "update-worktree",
      id: worktree.id,
      patch: {
        todos: nextTodos,
        todoHistory: nextHistory,
      },
    });
  };

  // Recovery sweep. A todo can be stranded in "done" forever: the status
  // persists as soon as the checkbox is clicked, but the archive only
  // happens on the 900ms timer — which the unmount cleanup above cancels.
  // Switch worktree/tab or quit inside that window and the item comes back
  // as a read-only, uncycleable "done" row that nothing will ever archive.
  // On mount and whenever the worktree changes, archive such items
  // immediately; they already missed their flash animation, so there is
  // nothing to wait for. Items with a live timer are mid-flash and are
  // left to their timer.
  useEffect(() => {
    for (const t of latest.current.todos) {
      if (t.status === "done" && !doneTimers.current.has(t.id)) {
        archiveDone(t.id);
      }
    }
  }, [worktree.id]);

  // Circle click cycles the state: todo → in_progress → done. Reaching
  // "done" flips the marker to a green check in place and leaves the row
  // sitting there for a beat before it drops out of the active list and
  // into History (empty items are just discarded, not archived).
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
    // Already flashing green — a second click shouldn't queue a duplicate.
    if (cur.status === "done") return;

    if (cur.text.trim() === "") {
      patch({ todos: todos.filter((t) => t.id !== id) });
      return;
    }

    // Show the green check right away, then archive after the flash.
    patch({
      todos: todos.map((t) => (t.id === id ? { ...t, status: "done" } : t)),
    });
    const timer = setTimeout(() => {
      doneTimers.current.delete(id);
      archiveDone(id);
    }, 900);
    doneTimers.current.set(id, timer);
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

  // Send a completed item back to the active list from History. The
  // history panel stays open — restoring one item shouldn't yank the user
  // away from the list they're browsing.
  const restore = (id: string) => {
    const cur = history.find((t) => t.id === id);
    if (!cur) return;
    const revived: TodoItem = { ...cur, status: "todo", completedAt: undefined };
    patch({
      todos: [...todos, revived],
      todoHistory: history.filter((t) => t.id !== id),
    });
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
      {/* Active todo list. Click anywhere in the scroll region (including
          the empty area below the rows) to append a new todo and focus it. */}
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

      {/* History bar pinned to the bottom. Click to expand a panel that
          grows upward over the list, filling about half the pane and
          scrolling through the whole archive; click again to collapse. */}
      <div style={{ flexShrink: 0 }}>
        {historyOpen && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: "50%",
              display: "flex",
              flexDirection: "column",
              backgroundColor: "var(--surface-1)",
              borderTop: "var(--border-1)",
              boxShadow: "0 -8px 24px -12px rgba(0,0,0,0.45)",
            }}
          >
            {/* "History" heading stays at the top of the expanded panel and
                doubles as the toggle — click it to collapse. The completed
                todos are listed under it. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setHistoryOpen(false)}
              title="Collapse history"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 var(--space-3)",
                height: 32,
                flexShrink: 0,
                cursor: "pointer",
                borderBottom: "var(--border-1)",
              }}
            >
              <HistoryIcon />
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--weight-medium)",
                  color: "var(--text-secondary)",
                }}
              >
                History
              </span>
              {history.length > 0 && (
                <span
                  className="tabular"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  {history.length}
                </span>
              )}
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    patch({ todoHistory: [] });
                  }}
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
          </div>
        )}

        {!historyOpen && (
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            aria-expanded={historyOpen}
            title="Show completed todos"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              height: 32,
              padding: "0 var(--space-3)",
              border: "none",
              borderTop: "var(--border-1)",
              backgroundColor: "var(--surface-2)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-medium)",
              transition:
                "background-color var(--motion-instant) var(--ease-out-quart)",
            }}
          >
            <HistoryIcon />
            <span>History</span>
            {history.length > 0 && (
              <span
                className="tabular"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--text-tertiary)",
                }}
              >
                {history.length}
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/** Clock-with-counterclockwise-arrow "history" glyph, drawn inline so it
 *  inherits the surrounding text color. */
function HistoryIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden
      style={{ opacity: 0.7 }}
    >
      <path
        d="M3 8 a5 5 0 1 0 1.6 -3.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="M3 2.5 L3 5 L5.5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 5 L8 8 L10.3 9.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
  const done = todo.status === "done";

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
          backgroundColor: hover && !done ? "var(--surface-2)" : "transparent",
          opacity: done ? 0.6 : 1,
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart), opacity var(--motion-fast) var(--ease-out-quart)",
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
          readOnly={done}
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
            color: done ? "var(--text-secondary)" : "var(--text-primary)",
            textDecoration: done ? "line-through" : "none",
            transition: "color var(--motion-fast) var(--ease-out-quart)",
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
          flexWrap: "nowrap",
          gap: 8,
          minWidth: 0,
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
            lineHeight: 1.2,
            color: "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {todo.text}
        </span>
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
