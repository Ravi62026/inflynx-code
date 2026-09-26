import React, { useRef } from "react";

interface ContextActionPopoverProps {
  onInsertText: (text: string) => void;
  onUploadClick: () => void;
  onClose: () => void;
}

interface ActionItem {
  id: string;
  prefix: string;
  label: string;
  desc: string;
  insertText?: string;
  isUpload?: boolean;
}

const ACTION_ITEMS: ActionItem[] = [
  {
    id: "upload-file",
    prefix: "📎",
    label: "Upload Image / File",
    desc: "Attach screenshot, mockups, or workspace files for vision analysis",
    isUpload: true,
  },
  {
    id: "active-file",
    prefix: "@",
    label: "Mention File / Directory",
    desc: "Reference specific files, functions, or workspace directories",
    insertText: "@",
  },
  {
    id: "codebase",
    prefix: "@",
    label: "Search Codebase Context",
    desc: "Include full workspace indexing and symbol search",
    insertText: "@codebase ",
  },
  {
    id: "explain",
    prefix: "/",
    label: "Explain Code",
    desc: "Analyze and explain architecture or logic flow",
    insertText: "/explain ",
  },
  {
    id: "test",
    prefix: "/",
    label: "Add Unit Tests",
    desc: "Generate comprehensive tests with edge case checks",
    insertText: "/test ",
  },
  {
    id: "debug",
    prefix: "/",
    label: "Debug Issue",
    desc: "Diagnose errors, runtime logs, and unexpected behaviors",
    insertText: "/debug ",
  },
  {
    id: "plan",
    prefix: "/",
    label: "Create Plan",
    desc: "Draft a structured implementation plan before editing code",
    insertText: "/plan ",
  },
];

export const ContextActionPopover: React.FC<ContextActionPopoverProps> = ({
  onInsertText,
  onUploadClick,
  onClose,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);

  return (
    <div className="floating-popover-container popover-context-anchor" ref={popoverRef}>
      <div className="popover-card">
        <div className="popover-header">
          <span className="popover-title">Context & Quick Actions</span>
          <button type="button" className="popover-close-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="popover-list-container">
          {ACTION_ITEMS.map((item) => (
            <div
              key={item.id}
              className="popover-item"
              onClick={() => {
                if (item.isUpload) {
                  onUploadClick();
                } else if (item.insertText) {
                  onInsertText(item.insertText);
                }
                onClose();
              }}
            >
              <div className="action-prefix-badge">{item.prefix}</div>
              <div className="item-main">
                <div className="item-title-row">
                  <span className="item-name">{item.label}</span>
                </div>
                <div className="item-desc">{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
