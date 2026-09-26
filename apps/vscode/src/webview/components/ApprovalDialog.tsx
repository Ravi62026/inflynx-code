import React from "react";
import type { ToolApprovalRequestPayload } from "../../types.js";
import { DiffPreview } from "./DiffPreview.js";

interface ApprovalDialogProps {
  request: ToolApprovalRequestPayload;
  onApprove: () => void;
  onDeny: () => void;
}

export const ApprovalDialog: React.FC<ApprovalDialogProps> = ({ request, onApprove, onDeny }) => {
  const args = request.args || {};
  const isFileEdit = request.toolName === "patch_file" || request.toolName === "write_file";
  const isShell = request.toolName === "execute_shell";

  return (
    <div className="approval-box">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontWeight: 700, color: "#facc15" }}>⚠️ Approval Required: {request.toolName}</span>
        <span className={`tool-badge ${request.permissionLevel}`}>{request.permissionLevel}</span>
      </div>

      {isShell && (
        <div style={{ margin: "6px 0", background: "rgba(0,0,0,0.4)", padding: "6px", borderRadius: "3px", fontFamily: "monospace", fontSize: "11px" }}>
          <code>$ {String(args.command || "")}</code>
        </div>
      )}

      {isFileEdit && (
        <div style={{ margin: "6px 0" }}>
          <DiffPreview
            // `patch_file` sends target_code/replacement_code and `write_file` sends
            // path/content. The old names meant this preview was always empty.
            targetSnippet={String(args.target_code || "")}
            replacementSnippet={String(args.replacement_code ?? args.content ?? "")}
            filePath={String(args.path || args.targetFile || "")}
          />
        </div>
      )}

      <div className="approval-actions">
        <button className="approve-btn" onClick={() => onApprove()}>
          ✓ Approve
        </button>
        <button className="deny-btn" onClick={() => onDeny()}>
          ✕ Deny
        </button>
      </div>
    </div>
  );
};
