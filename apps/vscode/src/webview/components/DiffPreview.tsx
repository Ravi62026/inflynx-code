import React from "react";

interface DiffPreviewProps {
  diff?: string;
  targetSnippet?: string;
  replacementSnippet?: string;
  filePath?: string;
}

export const DiffPreview: React.FC<DiffPreviewProps> = ({
  diff,
  targetSnippet,
  replacementSnippet,
  filePath,
}) => {
  if (diff) {
    const lines = diff.split("\n");
    return (
      <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: "4px", padding: "6px", fontFamily: "monospace", fontSize: "11px", overflowX: "auto" }}>
        {filePath && <div style={{ color: "#38bdf8", marginBottom: "4px", fontWeight: "bold" }}>{filePath}</div>}
        {lines.map((line, idx) => {
          let bg = "transparent";
          let color = "inherit";
          if (line.startsWith("+")) {
            bg = "rgba(74, 222, 128, 0.2)";
            color = "#4ade80";
          } else if (line.startsWith("-")) {
            bg = "rgba(239, 68, 68, 0.2)";
            color = "#f87171";
          } else if (line.startsWith("@@")) {
            color = "#818cf8";
          }
          return (
            <div key={idx} style={{ backgroundColor: bg, color, whiteSpace: "pre", padding: "1px 4px" }}>
              {line}
            </div>
          );
        })}
      </div>
    );
  }

  if (targetSnippet || replacementSnippet) {
    return (
      <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: "4px", padding: "6px", fontFamily: "monospace", fontSize: "11px" }}>
        {filePath && <div style={{ color: "#38bdf8", marginBottom: "4px", fontWeight: "bold" }}>{filePath}</div>}
        {targetSnippet && (
          <div style={{ background: "rgba(239, 68, 68, 0.15)", color: "#f87171", padding: "4px", borderRadius: "2px", marginBottom: "4px" }}>
            <div style={{ fontSize: "9px", opacity: 0.8, textTransform: "uppercase" }}>Original:</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{targetSnippet}</pre>
          </div>
        )}
        {replacementSnippet && (
          <div style={{ background: "rgba(74, 222, 128, 0.15)", color: "#4ade80", padding: "4px", borderRadius: "2px" }}>
            <div style={{ fontSize: "9px", opacity: 0.8, textTransform: "uppercase" }}>Replacement:</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{replacementSnippet}</pre>
          </div>
        )}
      </div>
    );
  }

  return null;
};
