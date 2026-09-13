import React, { useState, useEffect, useRef, useCallback } from "react";
import { useVSCodeAPI } from "./hooks/useVSCodeAPI.js";
import { ChatMessage, parseThinkTags } from "./components/ChatMessage.js";
import { ToolCallCard, type ToolCallState } from "./components/ToolCallCard.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { InputBox } from "./components/InputBox.js";
import { ModeSelector } from "./components/ModeSelector.js";
import { ModelBadge } from "./components/ModelBadge.js";
import { BudgetMeter } from "./components/BudgetMeter.js";
import type {
  AgentMode,
  BudgetStatePayload,
  ToWebviewMessage,
  ToolApprovalRequestPayload,
} from "../types.js";

interface MessageEntry {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thought?: string;
  tools?: ToolCallState[];
}

function hydrateMessages(loadedMsgs: any[], toolExecutions: any[] = []): MessageEntry[] {
  const result: MessageEntry[] = [];

  for (let i = 0; i < loadedMsgs.length; i++) {
    const m = loadedMsgs[i];

    if (m.role === "system") {
      result.push({
        id: m.id || `sys_${i}`,
        role: "system",
        content: m.content || "",
      });
      continue;
    }

    if (m.role === "user") {
      result.push({
        id: m.id || `user_${i}`,
        role: "user",
        content: m.content || "",
      });
      continue;
    }

    if (m.role === "assistant") {
      // 1. Extract thought / reasoning
      let thought: string | undefined = m.thought || m.reasoningContent;
      if (!thought && m.providerMetadataJson) {
        try {
          const meta = typeof m.providerMetadataJson === "string" ? JSON.parse(m.providerMetadataJson) : m.providerMetadataJson;
          if (meta?.openrouterReasoningDetails && Array.isArray(meta.openrouterReasoningDetails)) {
            thought = meta.openrouterReasoningDetails.map((d: any) => d?.summary || "").filter(Boolean).join("");
          }
        } catch {}
      }

      // Parse <think> tags if embedded in content
      const { content: cleanContent, thought: thinkFromContent } = parseThinkTags(m.content || "", thought);
      thought = thinkFromContent || thought;
      const content = cleanContent;

      // 2. Extract tool calls
      let tools: ToolCallState[] = [];
      if (m.toolCallsJson) {
        try {
          const calls = typeof m.toolCallsJson === "string" ? JSON.parse(m.toolCallsJson) : m.toolCallsJson;
          if (Array.isArray(calls)) {
            tools = calls.map((tc: any) => {
              const exec = toolExecutions?.find((e: any) => e.toolCallId === tc.id);
              let parsedArgs = tc.args;
              if (typeof parsedArgs === "string") {
                try { parsedArgs = JSON.parse(parsedArgs); } catch {}
              } else if (!parsedArgs && tc.function?.arguments) {
                try { parsedArgs = JSON.parse(tc.function.arguments); } catch {}
              }
              return {
                toolCallId: tc.id || `call_${Math.random()}`,
                toolName: tc.name || tc.function?.name || "tool",
                permissionLevel: "readonly" as const,
                args: parsedArgs || {},
                status: "completed" as const,
                output: exec?.outputSnippet || undefined,
                durationMs: exec?.durationMs || undefined,
                isError: exec?.isError || false,
              };
            });
          }
        } catch {}
      }

      // 3. Merge with preceding assistant message of the same turn
      const prev = result[result.length - 1];
      if (prev && prev.role === "assistant") {
        if (thought) {
          prev.thought = prev.thought ? `${prev.thought}\n${thought}` : thought;
        }
        if (tools.length > 0) {
          prev.tools = [...(prev.tools || []), ...tools];
        }
        if (content) {
          prev.content = prev.content ? `${prev.content}\n\n${content}` : content;
        }
      } else {
        // Skip if completely blank placeholder
        if (!content && !thought && tools.length === 0) {
          continue;
        }
        result.push({
          id: m.id || `assist_${i}`,
          role: "assistant",
          content: content || "",
          thought: thought || undefined,
          tools: tools.length > 0 ? tools : undefined,
        });
      }
    }
  }

  return result;
}

export const App: React.FC = () => {
  const { post } = useVSCodeAPI();

  const [sessionId, setSessionId] = useState<string>("");
  const [activeMode, setActiveMode] = useState<AgentMode>("agent");
  const [activeModel, setActiveModel] = useState<string>("openai/gpt-5.6-luna");
  const [activeProvider, setActiveProvider] = useState<string>("openrouter");
  const [budget, setBudget] = useState<BudgetStatePayload | undefined>();
  const [isConnected, setIsConnected] = useState<boolean>(false);

  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequestPayload | null>(null);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isAutoScrollActiveRef = useRef<boolean>(true);
  const [showJumpBottomBtn, setShowJumpBottomBtn] = useState<boolean>(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = chatContainerRef.current;
    if (!el) return;
    isAutoScrollActiveRef.current = true;
    setShowJumpBottomBtn(false);
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const lastScrollTopRef = useRef<number>(0);

  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current;
    if (!el) return;

    const currentScrollTop = el.scrollTop;
    const isScrollingUp = currentScrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = currentScrollTop;

    const distanceFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight;

    if (isScrollingUp) {
      // User is scrolling UP: pause auto-scroll immediately
      isAutoScrollActiveRef.current = false;
      if (distanceFromBottom > 35) {
        setShowJumpBottomBtn(true);
      }
      return;
    }

    // User is scrolling DOWN: only re-engage auto-scroll when reaching the very bottom
    if (distanceFromBottom <= 15) {
      isAutoScrollActiveRef.current = true;
      setShowJumpBottomBtn(false);
    } else if (distanceFromBottom > 35) {
      setShowJumpBottomBtn(true);
    }
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      // Immediate user intent to scroll UP: immediately unlock auto-scroll and reveal jump button
      isAutoScrollActiveRef.current = false;
      setShowJumpBottomBtn(true);
    }
  }, []);

  // Auto-scroll on streaming content updates only if user hasn't scrolled up
  useEffect(() => {
    if (!isAutoScrollActiveRef.current || !chatContainerRef.current) return;
    const el = chatContainerRef.current;
    const rafId = requestAnimationFrame(() => {
      if (isAutoScrollActiveRef.current && el) {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [messages, pendingApproval]);

  useEffect(() => {
    post({ type: "ready" });

    const handleMessage = (event: MessageEvent<ToWebviewMessage>) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case "server.status":
          setIsConnected(msg.payload.connected);
          break;

        case "mode.changed":
          setActiveMode(msg.payload.mode);
          break;

        case "model.changed":
          setActiveModel(msg.payload.model);
          if (msg.payload.provider) setActiveProvider(msg.payload.provider);
          break;

        case "budget.updated":
          setBudget(msg.payload);
          break;

        case "session.loaded": {
          const { session, messages: loadedMsgs, toolExecutions } = msg.payload;
          setSessionId(session.sessionId);
          setActiveMode(session.activeMode || "agent");
          setActiveModel(session.model || "openai/gpt-5.6-luna");
          setActiveProvider(session.providerId || "openrouter");

          const mapped = hydrateMessages(loadedMsgs, toolExecutions);
          setMessages(mapped);
          setIsRunning(false);
          setPendingApproval(null);
          requestAnimationFrame(() => scrollToBottom(false));
          break;
        }

        case "turn.started": {
          setIsRunning(true);
          setPendingApproval(null);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && !last.content && (!last.tools || last.tools.length === 0)) {
              return prev;
            }
            return [
              ...prev,
              {
                id: `user_${Date.now()}`,
                role: "user",
                content: msg.payload.prompt,
              },
              {
                id: `assist_${Date.now()}`,
                role: "assistant",
                content: "",
                thought: "",
                tools: [],
              },
            ];
          });
          break;
        }

        case "model.thought_delta": {
          const deltaText = (msg.payload as any)?.thought || (msg.payload as any)?.delta || (msg.payload as any)?.text || "";
          if (!deltaText) break;
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            if (last.role === "assistant") {
              last.thought = (last.thought || "") + deltaText;
              updated[updated.length - 1] = last;
            }
            return updated;
          });
          break;
        }

        case "model.text_delta": {
          const deltaText = (msg.payload as any)?.delta || (msg.payload as any)?.text || "";
          if (!deltaText) break;
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            if (last.role === "assistant") {
              last.content = (last.content || "") + deltaText;
              updated[updated.length - 1] = last;
            }
            return updated;
          });
          break;
        }

        case "tool.proposed": {
          const toolPayload = msg.payload;
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            if (last.role === "assistant") {
              const tools = last.tools ? [...last.tools] : [];
              tools.push({
                toolCallId: toolPayload.toolCallId,
                toolName: toolPayload.toolName,
                permissionLevel: toolPayload.permissionLevel,
                args: toolPayload.args,
                status: "proposed",
              });
              last.tools = tools;
              updated[updated.length - 1] = last;
            }
            return updated;
          });
          break;
        }

        case "tool.approval_required": {
          setPendingApproval(msg.payload);
          break;
        }

        case "tool.approved": {
          setPendingApproval(null);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            if (last.tools) {
              last.tools = last.tools.map((t) =>
                t.toolCallId === msg.payload.toolCallId ? { ...t, status: "approved" } : t
              );
              updated[updated.length - 1] = last;
            }
            return updated;
          });
          break;
        }

        case "tool.started": {
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            if (last.tools) {
              last.tools = last.tools.map((t) =>
                t.toolCallId === msg.payload.toolCallId ? { ...t, status: "executing" } : t
              );
              updated[updated.length - 1] = last;
            }
            return updated;
          });
          break;
        }

        case "tool.output": {
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            if (last.tools) {
              last.tools = last.tools.map((t) =>
                t.toolCallId === msg.payload.toolCallId
                  ? {
                      ...t,
                      status: "completed",
                      output: msg.payload.outputSnippet,
                      durationMs: msg.payload.durationMs,
                      isError: msg.payload.isError,
                    }
                  : t
              );
              updated[updated.length - 1] = last;
            }
            return updated;
          });
          break;
        }

        case "turn.completed": {
          setIsRunning(false);
          setPendingApproval(null);
          if (msg.payload.budgetState) {
            setBudget(msg.payload.budgetState);
          }
          // Remove empty assistant placeholder if turn completed without generating content
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (
              last &&
              last.role === "assistant" &&
              !last.content &&
              (!last.tools || last.tools.length === 0) &&
              !last.thought
            ) {
              return prev.slice(0, -1);
            }
            return prev;
          });
          break;
        }

        case "turn.failed": {
          setIsRunning(false);
          setPendingApproval(null);
          setMessages((prev) => {
            const filtered = prev.filter(
              (m, idx) =>
                !(
                  idx === prev.length - 1 &&
                  m.role === "assistant" &&
                  !m.content &&
                  (!m.tools || m.tools.length === 0) &&
                  !m.thought
                )
            );
            return [
              ...filtered,
              {
                id: `err_${Date.now()}`,
                role: "system",
                content: msg.payload.error,
              },
            ];
          });
          break;
        }

        case "turn.cancelled": {
          setIsRunning(false);
          setPendingApproval(null);
          break;
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const handleSendPrompt = useCallback((prompt: string) => {
    isAutoScrollActiveRef.current = true;
    setShowJumpBottomBtn(false);
    setIsRunning(true);
    setPendingApproval(null);
    setMessages((prev) => [
      ...prev,
      {
        id: `user_${Date.now()}`,
        role: "user",
        content: prompt,
      },
      {
        id: `assist_${Date.now()}`,
        role: "assistant",
        content: "",
        thought: "",
        tools: [],
      },
    ]);
    post({ type: "send.prompt", payload: { prompt } });
    requestAnimationFrame(() => scrollToBottom(false));
  }, [post, scrollToBottom]);

  const handleAbort = useCallback(() => {
    post({ type: "abort.turn" });
  }, [post]);

  const handleSelectMode = useCallback((mode: AgentMode) => {
    setActiveMode(mode);
    post({ type: "set.mode", payload: { mode } });
  }, [post]);

  const handleApproveTool = useCallback((toolCallId: string) => {
    setPendingApproval(null);
    post({ type: "approve.tool", payload: { toolCallId, approved: true } });
  }, [post]);

  const handleDenyTool = useCallback((toolCallId: string) => {
    setPendingApproval(null);
    post({ type: "approve.tool", payload: { toolCallId, approved: false } });
  }, [post]);

  const handleOpenFile = useCallback((filePath: string) => {
    post({ type: "open.file", payload: { filePath } });
  }, [post]);

  return (
    <div className="chat-app-layout">
      {/* Top HUD Header */}
      <div className="chat-header">
        <div className="chat-header-row">
          <div className="brand-badge">
            <div className={`status-dot ${isConnected ? "" : "offline"}`} />
            <span>INFLYNX</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <ModelBadge
              model={activeModel}
              provider={activeProvider}
              onClick={() => post({ type: "request.models" })}
            />
            <BudgetMeter budget={budget} />
          </div>
        </div>

        <ModeSelector currentMode={activeMode} onSelectMode={handleSelectMode} />
      </div>

      {!isConnected && (
        <div className="server-offline-banner">
          <span className="offline-icon">⚡</span>
          <div className="offline-content">
            <span className="offline-title">Backend Disconnected</span>
            <span className="offline-subtitle">Connecting to http://127.0.0.1:4000...</span>
          </div>
          <button className="offline-retry-btn" onClick={() => post({ type: "ready" })}>
            Retry
          </button>
        </div>
      )}

      {/* Message List */}
      <div
        className="chat-messages"
        ref={chatContainerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", marginTop: "40px", opacity: 0.6, fontSize: "12px" }}>
            <div style={{ fontSize: "28px", marginBottom: "8px" }}>⚡</div>
            <div style={{ fontWeight: 600 }}>Welcome to Inflynx Code</div>
            <div style={{ marginTop: "4px" }}>Autonomous AI coding agent in VS Code</div>
            <div style={{ marginTop: "12px", fontSize: "11px", opacity: 0.8 }}>
              Try: <code>Explain this codebase</code> or <code>Add unit tests for user service</code>
            </div>
          </div>
        ) : (
          messages.map((m, idx) => {
            if (
              m.role === "assistant" &&
              !m.content?.trim() &&
              !m.thought?.trim() &&
              (!m.tools || m.tools.length === 0) &&
              (!isRunning || idx !== messages.length - 1)
            ) {
              return null;
            }

            return (
              <div key={m.id || idx}>
                <ChatMessage
                  role={m.role}
                  content={m.content}
                  thought={m.thought}
                  tools={m.tools}
                  isStreaming={isRunning && idx === messages.length - 1}
                  onOpenFile={handleOpenFile}
                />
                {m.tools && m.tools.length > 0 && (
                  <div style={{ marginLeft: "6px", marginTop: "4px" }}>
                    {m.tools.map((tool) => (
                      <ToolCallCard key={tool.toolCallId} tool={tool} onOpenFile={handleOpenFile} />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}

        {pendingApproval && (
          <ApprovalDialog
            request={pendingApproval}
            onApprove={handleApproveTool}
            onDeny={handleDenyTool}
          />
        )}

      </div>

      {showJumpBottomBtn && (
        <button
          className="jump-to-bottom-btn"
          onClick={() => scrollToBottom(true)}
          title="Jump to latest"
        >
          ↓ Jump to latest
        </button>
      )}

      {/* Input Area */}
      <InputBox
        onSend={handleSendPrompt}
        onAbort={handleAbort}
        isRunning={isRunning}
        activeMode={activeMode}
      />
    </div>
  );
};
