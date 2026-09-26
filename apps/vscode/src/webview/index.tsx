import React, { Component, type ReactNode, type ErrorInfo } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/theme.css";
import "./styles/chat.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[Inflynx Webview] Uncaught render error:", error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "20px", color: "#f87171", fontFamily: "sans-serif", fontSize: "12px" }}>
          <h3 style={{ margin: "0 0 8px 0", color: "#ef4444" }}>⚠️ Inflynx UI Error</h3>
          <p style={{ margin: "0 0 12px 0", color: "#e2e8f0" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <pre style={{ background: "rgba(0,0,0,0.3)", padding: "8px", borderRadius: "4px", overflow: "auto", fontSize: "11px", color: "#cbd5e1" }}>
            {this.state.error?.stack || ""}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: "12px", background: "#38bdf8", color: "#000", border: "none", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontWeight: 600 }}
          >
            Reload Interface
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
