import React from "react";
import type { AgentMode } from "../../types.js";

interface ModeSelectorProps {
  currentMode: AgentMode;
  onSelectMode: (mode: AgentMode) => void;
}

const MODES: AgentMode[] = ["ask", "plan", "agent", "debug"];

export const ModeSelector: React.FC<ModeSelectorProps> = ({ currentMode, onSelectMode }) => {
  return (
    <div className="mode-selector">
      {MODES.map((mode) => (
        <button
          key={mode}
          className={`mode-btn ${currentMode === mode ? "active" : ""}`}
          onClick={() => onSelectMode(mode)}
        >
          {mode}
        </button>
      ))}
    </div>
  );
};
