import React from "react";

interface ModelBadgeProps {
  model: string;
  provider: string;
  onClick?: () => void;
}

export const ModelBadge: React.FC<ModelBadgeProps> = ({ model, provider, onClick }) => {
  const shortModel = model.includes("/") ? model.split("/")[1] : model;

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
        background: "rgba(255, 255, 255, 0.05)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: "4px",
        padding: "2px 6px",
        fontSize: "10px",
        cursor: "pointer",
        color: "var(--inflynx-fg)",
        userSelect: "none",
      }}
      title={`Active Model: ${model} (${provider})\nClick to change`}
    >
      <span style={{ color: "#38bdf8" }}>🧠</span>
      <span>{shortModel || "Select Model"}</span>
    </div>
  );
};
