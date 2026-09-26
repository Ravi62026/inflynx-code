import React, { useState, useEffect, useRef } from "react";
import type { ModelInfo, ReasoningEffort } from "../../types.js";

interface ModelEffortPopoverProps {
  activeModel: string;
  activeProvider: string;
  activeEffort: ReasoningEffort;
  modelsCatalog: ModelInfo[];
  onSelectModel: (model: string, provider: string) => void;
  onSelectEffort: (effort: ReasoningEffort) => void;
  onClose: () => void;
}

const DEFAULT_MODELS: ModelInfo[] = [
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openrouter", contextWindow: 1050000, description: "Advanced reasoning & deep tool agent" },
  { id: "google/gemini-3.6-flash", name: "Gemini 3.8 Flash", provider: "openrouter", contextWindow: 1048576, description: "Ultra-fast multimodal reasoning" },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", provider: "openrouter", contextWindow: 200000, description: "Exceptional coding & architecture" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "openrouter", contextWindow: 128000, description: "High-efficiency open weights agent" },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openrouter", contextWindow: 128000, description: "Versatile flagship model" },
];

const EFFORT_OPTIONS: Array<{ effort: ReasoningEffort; label: string; icon: string; desc: string }> = [
  { effort: "max", label: "Max", icon: "🚀", desc: "Exhaustive multi-turn deep reasoning" },
  { effort: "high", label: "High", icon: "🔥", desc: "Thorough verification & edge cases" },
  { effort: "medium", label: "Medium", icon: "⚡", desc: "Balanced speed & analytical depth" },
  { effort: "low", label: "Low", icon: "🌱", desc: "Fast tactical reasoning, low latency" },
  { effort: "none", label: "None", icon: "⭕", desc: "Direct response without thinking tokens" },
];

export const ModelEffortPopover: React.FC<ModelEffortPopoverProps> = ({
  activeModel,
  activeEffort,
  modelsCatalog,
  onSelectModel,
  onSelectEffort,
  onClose,
}) => {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"model" | "effort">("model");
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const catalogList: ModelInfo[] = Array.isArray(modelsCatalog)
    ? modelsCatalog
    : modelsCatalog && typeof modelsCatalog === "object"
    ? Object.values(modelsCatalog).flat()
    : [];

  const availableModels = catalogList.length > 0 ? catalogList : DEFAULT_MODELS;

  const filteredModels = availableModels.filter((m) => {
    if (!m) return false;
    const q = search.toLowerCase();
    return (
      m.name?.toLowerCase().includes(q) ||
      m.id?.toLowerCase().includes(q) ||
      m.provider?.toLowerCase().includes(q) ||
      m.description?.toLowerCase().includes(q)
    );
  });

  useEffect(() => {
    if (activeTab === "model") {
      searchInputRef.current?.focus();
    }
  }, [activeTab]);

  const formatContext = (ctx?: number) => {
    if (!ctx) return "";
    if (ctx >= 1_000_000) return `${Math.round(ctx / 100_000) / 10}M`;
    if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
    return `${ctx}`;
  };

  const getCleanModelName = (id: string, name?: string) => {
    if (name) return name;
    return id.includes("/") ? id.split("/")[1] : id;
  };

  return (
    <div className="floating-popover-container popover-model-anchor" ref={popoverRef}>
      <div className="popover-card">
        {/* Header with Segmented Tabs */}
        <div className="popover-header">
          <div className="popover-tabs">
            <button
              type="button"
              className={`popover-tab-btn ${activeTab === "model" ? "active" : ""}`}
              onClick={() => setActiveTab("model")}
            >
              Model
            </button>
            <button
              type="button"
              className={`popover-tab-btn ${activeTab === "effort" ? "active" : ""}`}
              onClick={() => setActiveTab("effort")}
            >
              Thinking Effort ({activeEffort ? String(activeEffort).toUpperCase() : "HIGH"})
            </button>
          </div>
          <button type="button" className="popover-close-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {activeTab === "model" ? (
          <div className="popover-body">
            {/* Search bar */}
            <div className="popover-search-box">
              <svg className="search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                className="popover-search-input"
                placeholder="Search models..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button type="button" className="clear-search-btn" onClick={() => setSearch("")}>
                  ✕
                </button>
              )}
            </div>

            {/* Models list */}
            <div className="popover-list-container">
              {filteredModels.map((m) => {
                const isSelected = m.id === activeModel;
                return (
                  <div
                    key={m.id}
                    className={`popover-item ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      onSelectModel(m.id, m.provider || "openrouter");
                      onClose();
                    }}
                  >
                    <div className="item-main">
                      <div className="item-title-row">
                        <span className="item-name">{getCleanModelName(m.id, m.name)}</span>
                        {m.contextWindow ? (
                          <span className="item-badge context-badge">
                            {formatContext(m.contextWindow)}
                          </span>
                        ) : null}
                        <span className="item-badge provider-badge">
                          {m.provider || "openrouter"}
                        </span>
                      </div>
                      {m.description && <div className="item-desc">{m.description}</div>}
                    </div>

                    {isSelected && <span className="item-check">✓</span>}
                  </div>
                );
              })}

              {filteredModels.length === 0 && (
                <div className="popover-empty">No models match "{search}"</div>
              )}
            </div>
          </div>
        ) : (
          <div className="popover-body">
            <div className="effort-intro">
              Control the reasoning budget and thinking tokens allocated for each turn.
            </div>

            <div className="popover-list-container">
              {EFFORT_OPTIONS.map((opt) => {
                const isSelected = opt.effort === activeEffort;
                return (
                  <div
                    key={opt.effort}
                    className={`popover-item ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      onSelectEffort(opt.effort);
                      onClose();
                    }}
                  >
                    <div className="effort-icon-badge">{opt.icon}</div>
                    <div className="item-main">
                      <div className="item-title-row">
                        <span className="item-name">{opt.label}</span>
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
        )}
      </div>
    </div>
  );
};
