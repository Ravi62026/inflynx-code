import React from "react";
import type { BudgetStatePayload } from "../../types.js";

interface BudgetMeterProps {
  budget?: BudgetStatePayload;
}

export const BudgetMeter: React.FC<BudgetMeterProps> = ({ budget }) => {
  if (!budget) return null;

  const turnPercent = Math.min(100, Math.round((budget.turnsUsed / budget.maxTurns) * 100));

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "10px", opacity: 0.8 }}>
      <span>🔋 {budget.turnsUsed}/{budget.maxTurns} turns</span>
      <div style={{ width: "40px", height: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", overflow: "hidden" }}>
        <div
          style={{
            width: `${turnPercent}%`,
            height: "100%",
            background: turnPercent > 80 ? "#ef4444" : "#10b981",
          }}
        />
      </div>
    </div>
  );
};
