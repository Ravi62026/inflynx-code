import React, { useState, useEffect, useMemo } from "react";
import { marked } from "marked";
import type { ToolCallState } from "./ToolCallCard.js";

interface ThinkingIndicatorProps {
  thought?: string;
  tools?: ToolCallState[];
  isStreaming?: boolean;
  hasContent?: boolean;
  onOpenFile?: (filePath: string) => void;
}

function formatArgsPreview(args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return "";
  if (typeof args.filePath === "string") return args.filePath;
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") return args.command;
  if (typeof args.query === "string") return args.query;
  const firstVal = Object.values(args)[0];
  if (typeof firstVal === "string") return firstVal;
  return JSON.stringify(args);
}

export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({
  thought,
  tools,
  isStreaming = false,
  hasContent = false,
  onOpenFile,
}) => {
  const hasTools = Boolean(tools && tools.length > 0);
  const [isExpanded, setIsExpanded] = useState<boolean>(isStreaming || (!hasContent && (Boolean(thought) || hasTools)));

  useEffect(() => {
    if (isStreaming) {
      setIsExpanded(true);
    }
  }, [isStreaming]);

  const renderedHtml = useMemo(() => {
    if (!thought) return "";
    try {
      return marked.parse(thought) as string;
    } catch {
      return thought;
    }
  }, [thought]);

  const wordsCount = thought ? thought.trim().split(/\s+/).filter(Boolean).length : 0;
  const toolsCount = tools?.length || 0;

  const isExecutingTool = tools?.some((t) => t.status === "executing" || t.status === "proposed");

  return (
    <div className={`thinking-block ${isExpanded ? "expanded" : "collapsed"}`}>
      <div
        className="thinking-header"
        onClick={(e) => {
          e.stopPropagation();
          setIsExpanded((prev) => !prev);
        }}
        title="Click to expand/collapse thinking process and actions"
      >
        <span className="thinking-icon">🧠</span>
        <span className="thinking-label">
          {isStreaming
            ? isExecutingTool
              ? "Executing tools..."
              : "Thinking..."
            : "Thought Process & Activity"}
        </span>

        {!isStreaming && wordsCount > 0 && (
          <span className="thinking-meta-pill">{wordsCount} words reasoning</span>
        )}
        {!isStreaming && toolsCount > 0 && (
          <span className="thinking-meta-pill">{toolsCount} {toolsCount === 1 ? "action" : "actions"}</span>
        )}
        {isStreaming && <div className="pulsing-dot" />}

        <span className="thinking-toggle-action">
          {isExpanded ? "▲ Collapse" : "▼ Click to view thoughts & actions"}
        </span>
      </div>

      {isExpanded && (
        <div className="thinking-body">
          {thought ? (
            <div
              className="thinking-markdown"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : isStreaming ? (
            <span style={{ opacity: 0.7 }}>Analyzing workspace context and formulating solution...</span>
          ) : (
            <div className="thinking-direct-note">
              💡 Model processed instructions directly based on workspace context and available tools.
            </div>
          )}

          {hasTools && (
            <div className="thinking-activity-section">
              <div className="thinking-activity-title">
                <span>🛠️ Workspace Actions ({toolsCount})</span>
              </div>
              {tools!.map((t) => {
                const argsPreview = formatArgsPreview(t.args);
                const isPath =
                  typeof t.args?.filePath === "string" ||
                  typeof t.args?.path === "string" ||
                  typeof t.args?.targetFile === "string";
                const pathVal =
                  (t.args?.filePath as string) ||
                  (t.args?.path as string) ||
                  (t.args?.targetFile as string) ||
                  "";

                return (
                  <div key={t.toolCallId} className="thinking-tool-item">
                    <span className={`thinking-tool-badge ${t.status}`}>
                      {t.status === "completed"
                        ? "✓ Done"
                        : t.status === "executing"
                        ? "⚡ Running"
                        : t.status === "proposed"
                        ? "⏳ Proposed"
                        : t.status}
                    </span>
                    <span className="thinking-tool-name">{t.toolName}</span>
                    {argsPreview && (
                      <span
                        className="thinking-tool-args"
                        title={argsPreview}
                        style={{ cursor: isPath ? "pointer" : "default" }}
                        onClick={() => {
                          if (isPath && pathVal && onOpenFile) {
                            onOpenFile(pathVal);
                          }
                        }}
                      >
                        {argsPreview}
                      </span>
                    )}
                    {t.durationMs !== undefined && (
                      <span className="thinking-tool-duration">{t.durationMs}ms</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
