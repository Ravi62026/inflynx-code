import React, { useRef } from "react";
import type { AgentMode } from "../../types.js";

interface ModePopoverProps {
  currentMode: AgentMode;
  onSelectMode: (mode: AgentMode) => void;
  onClose: () => void;
}

interface ModeOption {
  mode: AgentMode;
  title: string;
  icon: string;
  desc: string;
}

const MODE_OPTIONS: ModeOption[] = [
  {
    mode: "agent",
    title: "Agent",
    icon: "⚡",
    desc: "Autonomous execution, tool calling, and code editing.",
  },
  {
    mode: "plan",
    title: "Plan",
    icon: "📋",
    desc: "Architectural design plan first, waits for user approval.",
  },
  {
    mode: "ask",
    title: "Ask",
    icon: "💬",
    desc: "Read-only Q&A and code explanation without workspace edits.",
  },
  {
    mode: "debug",
    title: "Debug",
    icon: "🐞",
    desc: "Root-cause bug isolation and runtime error diagnosis.",
  },
];

export const ModePopover: React.FC<ModePopoverProps> = ({
  currentMode,
  onSelectMode,
  onClose,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);

  return (
    <div className="floating-popover-container popover-mode-anchor" ref={popoverRef}>
      <div className="popover-card">
        <div className="popover-header">
          <span className="popover-title">Agent Mode</span>
          <button type="button" className="popover-close-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="popover-list-container">
          {MODE_OPTIONS.map((opt) => {
            const isSelected = opt.mode === currentMode;
            return (
              <div
                key={opt.mode}
                className={`popover-item ${isSelected ? "selected" : ""}`}
                onClick={() => {
                  onSelectMode(opt.mode);
                  onClose();
                }}
              >
                <div className="mode-icon-badge">{opt.icon}</div>
                <div className="item-main">
                  <div className="item-title-row">
                    <span className="item-name">{opt.title}</span>
                    {isSelected && <span className="item-badge active-badge">Active</span>}
                  </div>
                  <div className="item-desc">{opt.desc}</div>
                </div>
                {isSelected && <span className="item-check">✓</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
