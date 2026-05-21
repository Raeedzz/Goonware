import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * When true (the default), a render crash blanks the whole app and
   * we render the global "Something broke" card. When false, we render
   * a compact inline fallback inside whatever container hosts this
   * boundary — used for per-pane boundaries so one broken pane doesn't
   * take the workspace down with it.
   */
  fullscreen?: boolean;
  /** Label shown in the inline fallback. Defaults to "this pane". */
  scope?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Top-of-tree error boundary. A render exception anywhere below would
 * otherwise blank the entire window — instead we trap it, surface a
 * minimal "something broke, here's what happened, try reload" card,
 * and log full details to the dev console for postmortem.
 *
 * Function-component error boundaries don't exist in React 19; this
 * stays a class. Reset is by reload — granular recovery (per-pane,
 * per-feature) lives in the panes themselves.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[Goonware] uncaught render error:", error, info);
    this.setState({ info });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({ error: null, info: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fullscreen === false) {
      // Inline fallback for a single pane. Stays inside its parent's
      // bounds — no blanking of the whole window.
      return (
        <div
          role="alert"
          style={{
            height: "100%",
            width: "100%",
            display: "grid",
            placeItems: "center",
            padding: "var(--space-4)",
            backgroundColor: "var(--surface-0)",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
              maxWidth: 320,
            }}
          >
            <div
              style={{
                fontWeight: "var(--weight-medium)",
                color: "var(--text-primary)",
              }}
            >
              {this.props.scope ?? "this pane"} crashed.
            </div>
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
                fontFamily: "var(--font-mono)",
                wordBreak: "break-word",
                whiteSpace: "pre-wrap",
              }}
            >
              {this.state.error.message}
            </div>
            <button
              type="button"
              onClick={this.handleReset}
              style={{
                marginTop: "var(--space-2)",
                padding: "var(--space-1) var(--space-3)",
                backgroundColor: "var(--surface-2)",
                color: "var(--text-primary)",
                fontSize: "var(--text-xs)",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          width: "100vw",
          display: "grid",
          placeItems: "center",
          padding: "var(--space-6)",
          backgroundColor: "var(--surface-1)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div
          style={{
            maxWidth: 560,
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
            padding: "var(--space-6)",
            backgroundColor: "var(--surface-2)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-modal)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-lg)",
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            Something broke.
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
              lineHeight: 1.5,
            }}
          >
            Goonware hit an unrecoverable render error. Reloading usually clears it.
            Full details are in the developer console.
          </div>
          <pre
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              padding: "var(--space-3)",
              backgroundColor: "var(--surface-1)",
              borderRadius: "var(--radius-sm)",
              maxHeight: 240,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              color: "var(--state-error-bright)",
              margin: 0,
            }}
          >
            {this.state.error.message}
          </pre>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                padding: "var(--space-2) var(--space-4)",
                backgroundColor: "var(--accent)",
                color: "var(--text-primary)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-sm)",
                fontWeight: "var(--weight-medium)",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
