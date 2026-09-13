import React, { useState } from "react";
import { DiffPreview } from "./DiffPreview.js";

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  permissionLevel?: "readonly" | "readwrite" | "shell";
  args: Record<string, unknown>;
  status: "proposed" | "approved" | "executing" | "completed" | "failed";
  output?: string;
  durationMs?: number;
  isError?: boolean;
}

interface ToolCallCardProps {
  tool: ToolCallState;
  onOpenFile?: (filePath: string) => void;
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ tool, onOpenFile }) => {
  const [expanded, setExpanded] = useState(false);

  const isFileEdit = tool.toolName === "patch_file" || tool.toolName === "write_file";
  const targetFile = String(tool.args?.targetFile || tool.args?.path || "");

  let statusIcon = "○";
  let statusColor = "#888";
  switch (tool.status) {
    case "proposed":
      statusIcon = "⏳";
      statusColor = "#facc15";
      break;
    case "approved":
      statusIcon = "✓";
      statusColor = "#38bdf8";
      break;
    case "executing":
      statusIcon = "⚡";
      statusColor = "#818cf8";
      break;
    case "completed":
      statusIcon = tool.isError ? "✕" : "✓";
      statusColor = tool.isError ? "#ef4444" : "#4ade80";
      break;
    case "failed":
      statusIcon = "✕";
      statusColor = "#ef4444";
      break;
  }

  return (
    <div className="tool-card">
      <div className="tool-header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-title">
          <span style={{ color: statusColor }}>{statusIcon}</span>
          <span>{tool.toolName}</span>
          {targetFile && (
            <span
              style={{ color: "#38bdf8", cursor: "pointer", textDecoration: "underline", fontSize: "10px" }}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFile?.(targetFile);
              }}
            >
              {targetFile.split("/").pop()}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {tool.durationMs !== undefined && (
            <span style={{ fontSize: "9.5px", opacity: 0.6 }}>{tool.durationMs}ms</span>
          )}
          {tool.permissionLevel && (
            <span className={`tool-badge ${tool.permissionLevel}`}>{tool.permissionLevel}</span>
          )}
          <span style={{ fontSize: "9px", opacity: 0.7 }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="tool-details">
          {isFileEdit ? (
            <DiffPreview
              targetSnippet={String(tool.args?.targetSnippet || "")}
              replacementSnippet={String(tool.args?.replacementSnippet || tool.args?.content || "")}
              filePath={targetFile}
            />
          ) : (
            <div>
              <div style={{ fontSize: "9px", opacity: 0.7, textTransform: "uppercase" }}>Arguments:</div>
              <pre style={{ margin: "2px 0 6px 0", padding: "4px", background: "rgba(0,0,0,0.3)", borderRadius: "3px", fontSize: "10px" }}>
                {JSON.stringify(tool.args, null, 2)}
              </pre>
            </div>
          )}

          {tool.output && (
            <div>
              <div style={{ fontSize: "9px", opacity: 0.7, textTransform: "uppercase", marginTop: "4px" }}>Output:</div>
              <div className="tool-output">{tool.output}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
