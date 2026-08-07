#!/usr/bin/env tsx

/**
 * Inflynx Code TUI Agent — Codex CLI Inspired Sleek Terminal Dashboard
 */

import React, { useState, useEffect, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { loadEnv, findWorkspaceRoot, TOP_PROVIDERS, type ProviderInfo } from "@inflynx/config";
import { streamModel, type Message } from "@inflynx/model-gateway";
import { ToolRegistry, executeTool, CORE_TOOLS, type ToolCall } from "@inflynx/tool-runtime";
import { buildWorkspaceIndex, type WorkspaceIndex } from "@inflynx/workspace-runtime";
import { HeaderHUD } from "./components/HeaderHUD.js";
import { ToolCard, type ToolLogEntry } from "./components/ToolCard.js";
import { FileDrawerModal } from "./components/FileDrawerModal.js";
import { MarkdownRenderer } from "./components/MarkdownRenderer.js";

interface ChatTurn {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolLogEntry[];
}

const App: React.FC = () => {
  const { exit } = useApp();
  const workspaceRoot = useMemo(() => findWorkspaceRoot(process.cwd()), []);

  useEffect(() => {
    process.env.INFLYNX_WORKSPACE_ROOT = workspaceRoot;
    loadEnv();
  }, [workspaceRoot]);

  // Terminal Dimensions Dynamic Hook
  const [terminalRows, setTerminalRows] = useState<number>(() =>
    process.stdout.rows ? Math.max(16, process.stdout.rows - 2) : 24
  );

  useEffect(() => {
    const handleResize = () => {
      if (process.stdout.rows) {
        setTerminalRows(Math.max(16, process.stdout.rows - 2));
      }
    };
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  // State
  const [workspaceIndex, setWorkspaceIndex] = useState<WorkspaceIndex>(() => buildWorkspaceIndex(workspaceRoot));
  const [activeProvider, setActiveProvider] = useState<ProviderInfo>(TOP_PROVIDERS[0]);
  const [activeModel, setActiveModel] = useState<string>(process.env.INFLYNX_AGENT_MODEL || TOP_PROVIDERS[0].defaultModel);
  const [showFileDrawer, setShowFileDrawer] = useState<boolean>(false);

  const [inputVal, setInputVal] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  const [turns, setTurns] = useState<ChatTurn[]>([
    { id: "1", role: "assistant", content: "⚡ **Welcome to Inflynx Agent** (Codex CLI Edition)\nType your query below or press `Tab` to toggle workspace files." },
  ]);

  const [totalTokens, setTotalTokens] = useState<number>(0);
  const [estimatedCostUsd, setEstimatedCostUsd] = useState<number>(0);

  const registry = useMemo(() => new ToolRegistry(CORE_TOOLS), []);
  const conversationHistory = useMemo<Message[]>(() => [
    { role: "system", content: "You are Inflynx Agent running in a sleek terminal CLI. Use markdown tables and formatted code blocks." }
  ], []);

  // Keyboard Navigation Controls (guarded for TTY terminals)
  useInput(
    (input, key) => {
      if (key.escape) {
        exit();
      }
      if (key.tab) {
        setShowFileDrawer((prev) => !prev);
      }
    },
    { isActive: Boolean(process.stdin.isTTY) }
  );

  const handleSubmit = async (userPrompt: string) => {
    const trimmed = userPrompt.trim();
    if (!trimmed || isStreaming) return;
    setInputVal("");

    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }

    if (trimmed === "/clear") {
      setTurns([{ id: String(Date.now()), role: "assistant", content: "⚡ Conversation cleared." }]);
      return;
    }

    // Add user turn
    const userTurnId = String(Date.now());
    setTurns((prev) => [...prev, { id: userTurnId, role: "user", content: trimmed }]);
    conversationHistory.push({ role: "user", content: trimmed });

    setIsStreaming(true);

    try {
      const apiKey = process.env[activeProvider.envKey] || "";
      let keepLooping = true;
      let loopCount = 0;
      const MAX_LOOPS = 8;

      while (keepLooping && loopCount < MAX_LOOPS) {
        loopCount++;
        let assistantText = "";
        let assistantReasoning = "";
        const assistantTurnId = String(Date.now() + Math.random());
        const pendingTools: ToolCall[] = [];

        setTurns((prev) => [...prev, { id: assistantTurnId, role: "assistant", content: "", toolCalls: [] }]);

        const stream = streamModel({
          provider: activeProvider.id,
          model: activeModel,
          messages: conversationHistory,
          apiKey,
          tools: registry.toOpenAIFormat(),
        });

        let lastUpdateMs = 0;

        for await (const event of stream) {
          if (event.type === "text_delta") {
            assistantText += event.text;
            const now = Date.now();
            if (now - lastUpdateMs > 80) {
              lastUpdateMs = now;
              setTurns((prev) =>
                prev.map((t) => (t.id === assistantTurnId ? { ...t, content: assistantText } : t))
              );
            }
          } else if (event.type === "thought_delta") {
            assistantReasoning += event.thought;
          } else if (event.type === "tool_call") {
            if (!pendingTools.some((t) => t.id === event.id)) {
              pendingTools.push({ id: event.id, name: event.name, args: event.args });
            }
          }
        }

        // Final update for complete assistant message
        setTurns((prev) =>
          prev.map((t) => (t.id === assistantTurnId ? { ...t, content: assistantText } : t))
        );

        // Record assistant turn in history with tool_calls and reasoning_content
        const assistantMsg: Message = { role: "assistant", content: assistantText };
        if (assistantReasoning) {
          assistantMsg.reasoning_content = assistantReasoning;
        }
        if (pendingTools.length > 0) {
          assistantMsg.tool_calls = pendingTools.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        conversationHistory.push(assistantMsg);

        // Update token counter estimate
        const estTokens = (trimmed.length + assistantText.length) / 4;
        setTotalTokens((prev) => prev + estTokens);
        setEstimatedCostUsd((prev) => prev + (estTokens / 1_000_000) * 0.15);

        // If tools are requested, execute them and stay in loop!
        if (pendingTools.length > 0) {
          for (const tc of pendingTools) {
            const toolLogId = String(Date.now() + Math.random());
            const newToolCard: ToolLogEntry = {
              id: toolLogId,
              name: tc.name,
              args: tc.args,
              status: "running",
            };

            // Attach tool call card to assistant turn
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantTurnId
                  ? { ...t, toolCalls: [...(t.toolCalls || []), newToolCard] }
                  : t
              )
            );

            const startMs = Date.now();
            const result = await executeTool(registry, tc);
            const durationMs = Date.now() - startMs;

            // Update tool card status & duration
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantTurnId
                  ? {
                      ...t,
                      toolCalls: (t.toolCalls || []).map((tcCard) =>
                        tcCard.id === toolLogId
                          ? {
                              ...tcCard,
                              status: result.isError ? "error" : "success",
                              durationMs,
                              outputSnippet: result.output.slice(0, 150),
                            }
                          : tcCard
                      ),
                    }
                  : t
              )
            );

            conversationHistory.push({
              role: "tool",
              content: result.output,
              tool_call_id: tc.id,
            });
          }
          // Loop continues so LLM gets tool results!
        } else {
          // No tools requested, loop ends normally
          keepLooping = false;
        }
      }

    } catch (err: any) {
      setTurns((prev) => [
        ...prev,
        { id: String(Date.now()), role: "assistant", content: `❌ **Error:** ${err?.message || String(err)}` },
      ]);
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <Box flexDirection="column" width="100%" height={terminalRows} paddingX={1}>
      {/* 1. Header Telemetry HUD */}
      <HeaderHUD
        model={activeModel}
        provider={activeProvider.id}
        workspaceRoot={workspaceRoot}
        totalTokens={totalTokens}
        estimatedCostUsd={estimatedCostUsd}
        showFileDrawer={showFileDrawer}
      />

      {/* 2. Optional File Drawer Modal Overlay (Tab Key) */}
      <FileDrawerModal index={workspaceIndex} isOpen={showFileDrawer} />

      {/* 3. Main Full-Width Single-Column Message Stream */}
      <Box flexDirection="column" flexGrow={1} width="100%">
        {turns.slice(-4).map((t) => (
          <Box key={t.id} flexDirection="column" marginBottom={1} width="100%">
            <Box gap={1} marginBottom={0}>
              <Text bold color={t.role === "user" ? "brightCyan" : "magenta"}>
                {t.role === "user" ? "👤 You" : "⚡ Inflynx"}
              </Text>
            </Box>

            {t.role === "assistant" ? (
              <Box flexDirection="column" paddingLeft={1} width="100%">
                <MarkdownRenderer content={t.content || "..."} />
                {t.toolCalls && t.toolCalls.length > 0 && (
                  <Box flexDirection="column" marginTop={1}>
                    {t.toolCalls.map((tcLog) => (
                      <ToolCard key={tcLog.id} log={tcLog} />
                    ))}
                  </Box>
                )}
              </Box>
            ) : (
              <Box paddingLeft={1}>
                <Text>{t.content}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>

      {/* 4. Bottom Sleek Codex Command Input Bar */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between" width="100%">
        <Box gap={1} width="100%">
          <Text bold color="cyan">
            ❯
          </Text>
          {isStreaming ? (
            <Text color="yellow">
              <Spinner type="dots" /> Thinking & Streaming response...
            </Text>
          ) : (
            <TextInput
              value={inputVal}
              onChange={setInputVal}
              onSubmit={handleSubmit}
              placeholder="Ask Inflynx... (Press Tab for file drawer, Esc to quit)"
            />
          )}
        </Box>
      </Box>
    </Box>
  );
};

render(<App />);
