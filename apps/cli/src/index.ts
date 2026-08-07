#!/usr/bin/env node

/**
 * Inflynx Code CLI Agent — Full Agentic Loop with Surgical Patching & Diff Previews
 */

import fs from "fs";
import path from "path";
import { select, password, search, confirm } from "@inquirer/prompts";
import { loadEnv, saveKeyToEnv, redactSecrets, findWorkspaceRoot, TOP_PROVIDERS, type ProviderInfo } from "@inflynx/config";
import { streamModel, type Message } from "@inflynx/model-gateway";
import { ToolRegistry, executeTool, CORE_TOOLS, type ToolCall } from "@inflynx/tool-runtime";
import { applySurgicalPatch, computeUnifiedDiff } from "@inflynx/patch-engine";
import { McpClientManager } from "@inflynx/mcp-runtime";
import { SkillManager } from "@inflynx/skill-runtime";
import {
  buildWorkspaceIndex,
  rankFilesByRelevance,
  parseAtMentions,
  resolveAtMentionContext,
  type WorkspaceIndex,
} from "@inflynx/workspace-runtime";
import {
  displayWelcomeBanner,
  formatPrompt,
  askUserPrompt,
  renderColorDiff,
  colors,
} from "@inflynx/ui-components";

// ─── Slash Command Palette ─────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { name: "/provider",     value: "/provider",     description: "Select AI Provider & configure API key" },
  { name: "/model",        value: "/model",        description: "Select AI Model across providers" },
  { name: "/tools",       value: "/tools",        description: "List available agent tools" },
  { name: "/mcp",         value: "/mcp",          description: "Manage & list Model Context Protocol (MCP) connectors" },
  { name: "/skills",      value: "/skills",       description: "List & view discovered agent skills (.inflynx/skills)" },
  { name: "/create-skill",value: "/create-skill", description: "Interactively create a new reusable agent skill" },
  { name: "/index",       value: "/index",        description: "View workspace index summary & relevant files" },
  { name: "/clear",       value: "/clear",        description: "Clear terminal screen & conversation" },
  { name: "/help",        value: "/help",         description: "Show all available commands" },
  { name: "/exit",        value: "/exit",         description: "Exit Inflynx Code CLI agent" },
];

const KNOWN_COMMANDS = new Set(SLASH_COMMANDS.map((c) => c.value.slice(1)));

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getApiKeyForProvider(providerId: string): string | undefined {
  const provider = TOP_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return undefined;
  return process.env[provider.envKey];
}

function printToolApprovalHeader(toolName: string, args: Record<string, unknown>) {
  console.log();
  console.log(`${colors.bold}${colors.yellow}🔧 Tool Request: ${toolName}${colors.reset}`);
  console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
  for (const [k, v] of Object.entries(args)) {
    const valStr = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "..." : String(v ?? "");
    console.log(`  ${colors.cyan}${k}${colors.reset}: ${colors.bold}${valStr}${colors.reset}`);
  }
  console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
}

// ─── Dropdowns ────────────────────────────────────────────────────────────────

async function selectSlashCommand(typed: string): Promise<string | null> {
  const cleanTerm = typed.toLowerCase().replace(/^\/+/, "");
  console.log();
  return search<string>({
    message: `${colors.bold}${colors.brightCyan}Select command (type to filter):${colors.reset}`,
    source: async (input) => {
      const term = ((input ?? cleanTerm)).toLowerCase().replace(/^\/+/, "");
      return SLASH_COMMANDS
        .filter((c) => c.value.includes(term) || c.description.toLowerCase().includes(term))
        .map((c) => ({
          name: `${colors.bold}${colors.brightMagenta}${c.name.padEnd(12)}${colors.reset} ${colors.gray}— ${c.description}${colors.reset}`,
          value: c.value,
        }));
    },
    pageSize: 8,
  });
}

async function selectProviderDropdown(currentId: string): Promise<ProviderInfo | null> {
  console.log();
  const id = await select({
    message: `${colors.bold}${colors.brightCyan}Select AI Provider:${colors.reset}`,
    choices: TOP_PROVIDERS.map((p) => {
      const hasKey = Boolean(process.env[p.envKey]);
      const statusTag = hasKey ? `${colors.brightGreen}✓ Configured${colors.reset}` : `${colors.red}✗ Missing ${p.envKey}${colors.reset}`;
      const badge = p.id === currentId ? ` ${colors.brightMagenta}(ACTIVE)${colors.reset}` : "";
      return { name: `${p.name.padEnd(16)} [${statusTag}]${badge}`, value: p.id };
    }),
    pageSize: 8,
  });
  return TOP_PROVIDERS.find((p) => p.id === id) || null;
}

async function selectModelDropdown(currentModel: string, provider: ProviderInfo): Promise<string> {
  console.log();
  return select({
    message: `${colors.bold}${colors.brightCyan}Select Model for ${provider.name}:${colors.reset}`,
    choices: provider.models.map((m) => ({
      name: m + (m === currentModel ? ` ${colors.brightMagenta}(ACTIVE)${colors.reset}` : ""),
      value: m,
    })),
    pageSize: 8,
  });
}

async function selectAllModelsDropdown(currentModel: string, currentProviderId: string) {
  const choices: Array<{ name: string; value: { model: string; providerId: string } }> = [];
  for (const p of TOP_PROVIDERS) {
    const hasKey = Boolean(process.env[p.envKey]);
    const ks = hasKey ? `${colors.brightGreen}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    for (const m of p.models) {
      const badge = (m === currentModel && p.id === currentProviderId) ? ` ${colors.brightMagenta}(ACTIVE)${colors.reset}` : "";
      choices.push({ name: `[${ks} ${p.name}] ${m}${badge}`, value: { model: m, providerId: p.id } });
    }
  }
  console.log();
  const sel = await select({
    message: `${colors.bold}${colors.brightCyan}Select AI Model:${colors.reset}`,
    choices,
    pageSize: 12,
  });
  return TOP_PROVIDERS.find((p) => p.id === sel.providerId)
    ? { model: sel.model, provider: TOP_PROVIDERS.find((p) => p.id === sel.providerId)! }
    : null;
}

// ─── Main REPL ────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();

  // Find true monorepo workspace root
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  process.env.INFLYNX_WORKSPACE_ROOT = workspaceRoot;

  // Init tool registry, MCP client manager, Skill manager & workspace indexer
  const registry = new ToolRegistry(CORE_TOOLS);
  const mcpManager = new McpClientManager();
  const mcpServers = await mcpManager.connectAll(workspaceRoot);
  const mcpToolsCount = mcpManager.registerToolsInto(registry);

  const skillManager = new SkillManager();
  const discoveredSkills = skillManager.discoverSkills(workspaceRoot);

  let workspaceIndex: WorkspaceIndex = buildWorkspaceIndex(workspaceRoot);

  // Determine active provider
  let activeProvider: ProviderInfo = TOP_PROVIDERS[0];
  const envProvider = process.env.INFLYNX_AGENT_PROVIDER;
  if (envProvider) {
    const m = TOP_PROVIDERS.find((p) => p.id === envProvider);
    if (m) activeProvider = m;
  } else {
    const withKey = TOP_PROVIDERS.find((p) => process.env[p.envKey]);
    if (withKey) activeProvider = withKey;
  }

  let activeModel = process.env.INFLYNX_AGENT_MODEL || activeProvider.defaultModel;
  let activeApiKey = getApiKeyForProvider(activeProvider.id);

  displayWelcomeBanner(activeModel, activeProvider.id, workspaceRoot);

  if (!activeApiKey) {
    console.log(`${colors.yellow}⚠ Warning: No API key for [${activeProvider.name}]. Use /provider to configure.${colors.reset}\n`);
  }

  console.log(`${colors.gray}⚡ Indexed ${workspaceIndex.totalFiles} workspace files (.gitignore aware) in ${workspaceRoot}${colors.reset}\n`);

  // System prompt with tool & skill documentation
  const availableSkillsOverview = skillManager.listSkills().length > 0
    ? `\nDiscovered Skills:\n` + skillManager.listSkills().map((s) => `- ${s.metadata.name} (${s.id}): ${s.metadata.description}`).join("\n")
    : "";

  const systemPrompt = [
    "You are Inflynx Agent, an expert AI coding assistant running in the user's terminal.",
    "You have access to tools: read_file, patch_file, write_file, list_directory, search_files, web_search, fetch_url, execute_shell.",
    "Use web_search and fetch_url when asked to search Google/internet or read online documentation.",
    "PREFER patch_file OVER write_file for editing existing files. patch_file surgically replaces only the target code block.",
    "Use tools proactively to read code before editing, list directories to understand structure, and run tests to verify changes.",
    "Support @filename mentions for auto-attached context.",
    availableSkillsOverview,
    "Be concise. When you use a tool, explain why briefly before calling it.",
    "After every patch_file, write_file, or execute_shell, summarize what changed and what to do next.",
    `Current workspace: ${workspaceRoot}`,
  ].filter(Boolean).join("\n");

  const conversationHistory: Message[] = [
    { role: "system", content: systemPrompt },
  ];

  // ─── REPL Loop ──────────────────────────────────────────────────────────────
  while (true) {
    let inputStr = await askUserPrompt(formatPrompt(workspaceRoot));
    if (!inputStr) continue;

    // ─── Slash Command Handling ────────────────────────────────────────────────
    if (inputStr.startsWith("/")) {
      const firstWord = inputStr.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      if (!KNOWN_COMMANDS.has(firstWord) && inputStr.trim() !== "/") {
        console.log(`${colors.red}Unknown command: /${firstWord}${colors.reset}. Type /help.\n`);
        continue;
      }

      if (inputStr.trim() === "/") {
        try {
          const picked = await selectSlashCommand(inputStr);
          if (picked) inputStr = picked;
          else continue;
        } catch { continue; }
      }

      const parts = inputStr.slice(1).trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      const arg = parts[1];

      if (cmd === "help") {
        console.log(`\n${colors.bold}Available slash commands:${colors.reset}`);
        for (const c of SLASH_COMMANDS) {
          console.log(`  ${colors.cyan}${c.name.padEnd(12)}${colors.reset} ${colors.gray}— ${c.description}${colors.reset}`);
        }
        console.log();
        continue;
      }

      if (cmd === "index") {
        workspaceIndex = buildWorkspaceIndex(workspaceRoot);
        console.log(`\n${colors.bold}Workspace Index Summary:${colors.reset}`);
        console.log(`  Directory: ${colors.cyan}${workspaceRoot}${colors.reset}`);
        console.log(`  Total files: ${colors.brightGreen}${workspaceIndex.totalFiles}${colors.reset}`);
        console.log(`  Indexed at: ${new Date(workspaceIndex.indexedAt).toLocaleTimeString()}`);
        console.log();
        continue;
      }

      if (cmd === "tools") {
        console.log(`\n${colors.bold}Available Agent Tools:${colors.reset}`);
        for (const t of registry.list()) {
          const perm = t.permissionLevel === "shell" ? colors.red : t.permissionLevel === "readwrite" ? colors.yellow : colors.brightGreen;
          const originTag = t.origin === "mcp" ? `${colors.brightMagenta}[MCP:${t.serverName}]${colors.reset} ` : "";
          console.log(`  ${colors.cyan}${t.name.padEnd(30)}${colors.reset} ${originTag}${perm}[${t.permissionLevel}]${colors.reset}  ${colors.gray}${t.description}${colors.reset}`);
        }
        console.log();
        continue;
      }

      if (cmd === "mcp") {
        const subCmd = parts[1]?.toLowerCase();
        const query = parts.slice(2).join(" ");

        if (subCmd === "add" && query) {
          console.log(`\n${colors.brightCyan}⚡ Auto-discovering MCP Server for: "${query}"...${colors.reset}`);
          inputStr = [
            `The user wants to add an MCP (Model Context Protocol) server for: "${query}".`,
            `Please follow these steps:`,
            `1. Use web_search to find the official/popular npm package or command for the "${query}" MCP server (e.g. @modelcontextprotocol/server-github, @figma/mcp-server, etc.).`,
            `2. Read the configuration requirements (command, args, env vars).`,
            `3. Use patch_file or write_file to add this new server configuration to .inflynx/mcp.json under "mcpServers".`,
            `4. Inform the user what was added and ask them to restart or run /mcp list.`,
          ].join("\n");
          // Proceed into LLM execution loop below instead of slash command continue!
        } else {
          console.log(`\n${colors.bold}${colors.brightMagenta}🔌 Model Context Protocol (MCP) Connectors:${colors.reset}`);
          const servers = mcpManager.listServers();
          if (servers.length === 0) {
            console.log(`  ${colors.gray}No MCP servers configured in .inflynx/mcp.json${colors.reset}\n`);
          } else {
            for (const s of servers) {
              const statusColor = s.status === "connected" ? colors.brightGreen : s.status === "disabled" ? colors.yellow : colors.red;
              console.log(`  ${colors.cyan}• ${s.config.id}${colors.reset} [${statusColor}${s.status}${colors.reset}] — ${s.config.transport.toUpperCase()} ${s.config.command || s.config.url || ""}`);
              if (s.tools.length > 0) {
                console.log(`    ${colors.gray}Tools (${s.tools.length}): ${s.tools.map((t) => t.name).join(", ")}${colors.reset}`);
              }
              if (s.error) {
                console.log(`    ${colors.red}Error: ${s.error}${colors.reset}`);
              }
            }
            console.log();
          }
          console.log(`${colors.gray}Tip: Type '/mcp add figma' or '/mcp add github' to auto-find and configure new MCP servers!${colors.reset}\n`);
          continue;
        }
      }

      if (cmd === "skills") {
        const subCmd = parts[1]?.toLowerCase();
        const query = parts.slice(2).join(" ");

        if (subCmd === "add" && query) {
          console.log(`\n${colors.brightCyan}⚡ Auto-researching & Generating Skill for: "${query}"...${colors.reset}`);
          inputStr = [
            `The user wants to create a new agent skill for: "${query}".`,
            `Please follow these steps:`,
            `1. Use web_search to find best practices, guidelines, rules, and prompt techniques for "${query}".`,
            `2. Synthesize the findings into structured SKILL.md format with YAML frontmatter (name, description, tags).`,
            `3. Use write_file to create the new skill file at: .inflynx/skills/${query.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}/SKILL.md`,
            `4. Inform the user that the skill has been created and saved!`,
          ].join("\n");
          // Proceed to LLM execution loop
        } else {
          console.log(`\n${colors.bold}${colors.brightMagenta}🧠 Discovered Agent Skills:${colors.reset}`);
          const skillsList = skillManager.listSkills();
          if (skillsList.length === 0) {
            console.log(`  ${colors.gray}No skills found in .inflynx/skills or skills/${colors.reset}`);
            console.log(`  ${colors.gray}Type '/skills add <requirement>' to auto-create a new skill!${colors.reset}\n`);
          } else {
            for (const s of skillsList) {
              console.log(`  ${colors.cyan}• ${s.metadata.name}${colors.reset} ${colors.gray}(${s.id})${colors.reset}`);
              console.log(`    ${colors.gray}${s.metadata.description}${colors.reset}`);
              console.log(`    ${colors.dim}Location: ${s.filePath}${colors.reset}`);
            }
            console.log();
          }
          console.log(`${colors.gray}Tip: Type '/skills add remove ai content and plag' to auto-generate a new skill!${colors.reset}\n`);
          continue;
        }
      }

      if (cmd === "create-skill") {
        console.log(`\n${colors.bold}${colors.brightCyan}⚡ Create New Agent Skill:${colors.reset}`);
        const nameInput = await askUserPrompt(`${colors.yellow}Skill Name (e.g. Jira Ticket Sync):${colors.reset} `);
        if (!nameInput.trim()) continue;

        const descInput = await askUserPrompt(`${colors.yellow}Skill Description:${colors.reset} `);
        const instructionsInput = await askUserPrompt(`${colors.yellow}Step-by-step Instructions for the Agent:${colors.reset} `);

        const skillDef = skillManager.createSkill(
          nameInput.toLowerCase().replace(/\s+/g, "-"),
          { name: nameInput.trim(), description: descInput.trim() },
          instructionsInput.trim(),
          workspaceRoot
        );

        console.log(`\n${colors.brightGreen}✓ Skill Created Successfully!${colors.reset}`);
        console.log(`  Saved to: ${colors.cyan}${skillDef.filePath}${colors.reset}\n`);
        continue;
      }

      if (cmd === "provider") {
        try {
          let target: ProviderInfo | null = null;
          if (arg) {
            target = TOP_PROVIDERS.find((p) => p.id === arg || p.name.toLowerCase().includes(arg.toLowerCase())) || null;
          } else {
            target = await selectProviderDropdown(activeProvider.id);
          }
          if (target) {
            let key = getApiKeyForProvider(target.id);
            if (!key) {
              console.log();
              const entered = await password({
                message: `${colors.yellow}Enter API Key for ${target.name} (${target.envKey}):${colors.reset}`,
                mask: "*",
              });
              if (entered.trim()) { saveKeyToEnv(target.envKey, entered.trim()); key = entered.trim(); console.log(`${colors.brightGreen}✓ Key saved!${colors.reset}`); }
            }
            const chosenModel = await selectModelDropdown(target.defaultModel, target);
            activeProvider = target; activeModel = chosenModel; activeApiKey = key;
            console.log(`\n${colors.brightGreen}✓ Provider:${colors.reset} ${target.name}  ${colors.brightCyan}Model:${colors.reset} ${activeModel}`);
            if (!key) console.log(`${colors.yellow}⚠ ${target.envKey} is missing.${colors.reset}`);
            else console.log(`${colors.gray}Key: ${redactSecrets("Key: " + key)}${colors.reset}`);
            console.log();
          }
        } catch { console.log(); }
        continue;
      }

      if (cmd === "model") {
        try {
          if (arg) {
            for (const p of TOP_PROVIDERS) {
              const match = p.models.find((m) => m.toLowerCase().includes(arg.toLowerCase()));
              if (match) { activeProvider = p; activeModel = match; activeApiKey = getApiKeyForProvider(p.id); break; }
            }
            console.log(`\n${colors.brightGreen}✓ Model:${colors.reset} ${activeModel} (${activeProvider.name})\n`);
          } else {
            const res = await selectAllModelsDropdown(activeModel, activeProvider.id);
            if (res) {
              activeProvider = res.provider; activeModel = res.model;
              activeApiKey = getApiKeyForProvider(res.provider.id);
              console.log(`\n${colors.brightGreen}✓ Provider:${colors.reset} ${res.provider.name}  ${colors.brightCyan}Model:${colors.reset} ${activeModel}\n`);
            }
          }
        } catch { console.log(); }
        continue;
      }

      if (cmd === "clear") {
        conversationHistory.splice(1);
        console.clear();
        displayWelcomeBanner(activeModel, activeProvider.id, workspaceRoot);
        continue;
      }

      if (cmd === "exit" || cmd === "quit") {
        mcpManager.disconnectAll();
        console.log(`\n${colors.cyan}Goodbye! 👋${colors.reset}\n`);
        process.exit(0);
      }

      // If command was /mcp add or /skills add, break out of slash command branch to let LLM process the prompt!
      if ((cmd === "mcp" || cmd === "skills") && parts[1]?.toLowerCase() === "add") {
        // Continue to prompt execution below
      } else {
        console.log(`${colors.red}Unknown command: /${cmd}${colors.reset}. Type /help.\n`);
        continue;
      }
    }

    // ─── Check API Key ─────────────────────────────────────────────────────────
    if (!activeApiKey) {
      console.log(`\n${colors.red}❌ ${activeProvider.envKey} is missing. Use /provider to configure.\n${colors.reset}`);
      continue;
    }

    // ─── Process @ Mentions & Auto-Context ──────────────────────────────────────
    let finalPromptContent = inputStr;
    const rawMentions = parseAtMentions(inputStr, workspaceIndex);
    
    // Deduplicate mentions by filePath
    const uniqueMentionsMap = new Map<string, typeof rawMentions[0]>();
    for (const m of rawMentions) {
      if (!uniqueMentionsMap.has(m.filePath)) {
        uniqueMentionsMap.set(m.filePath, m);
      }
    }
    const mentions = Array.from(uniqueMentionsMap.values());

    if (mentions.length > 0) {
      console.log(`${colors.brightMagenta}📎 Mentioned Files:${colors.reset} ${mentions.map((m) => m.filePath).join(", ")}`);
      const mentionContext = resolveAtMentionContext(mentions);
      finalPromptContent = `${inputStr}\n\n=== Attached Context ===\n${mentionContext}`;
    } else {
      const relevantFiles = rankFilesByRelevance(workspaceIndex, inputStr, undefined, 3);
      if (relevantFiles.length > 0 && relevantFiles[0].score > 3) {
        const topMatches = relevantFiles.map((r) => r.file.relativePath).join(", ");
        console.log(`${colors.gray}🔍 Auto-matched context: ${topMatches}${colors.reset}`);
      }
    }

    // Auto-match discovered skills
    const matchedSkills = skillManager.matchSkills(inputStr, 2);
    if (matchedSkills.length > 0) {
      console.log(`${colors.brightMagenta}🧠 Matched Skills:${colors.reset} ${matchedSkills.map((s) => s.metadata.name).join(", ")}`);
      const skillBlocks = matchedSkills.map((s) => `<skill name="${s.metadata.name}">\n${s.instructions}\n</skill>`).join("\n\n");
      finalPromptContent += `\n\n=== Relevant Active Skills ===\n${skillBlocks}`;
    }

    // ─── Agentic Loop ─────────────────────────────────────────────────────────
    conversationHistory.push({ role: "user", content: finalPromptContent });
    let continueLoop = true;

    while (continueLoop) {
      continueLoop = false;
      console.log();
      process.stdout.write(`${colors.brightCyan}⚡ Inflynx (${activeModel}):${colors.reset} `);

      let assistantText = "";
      let assistantReasoning = "";
      const pendingToolCallsMap = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();

      try {
        const stream = streamModel({
          provider: activeProvider.id,
          model: activeModel,
          messages: conversationHistory,
          apiKey: activeApiKey,
          tools: registry.toOpenAIFormat(),
        });

        for await (const event of stream) {
          if (event.type === "text_delta") {
            process.stdout.write(event.text);
            assistantText += event.text;
          } else if (event.type === "tool_call") {
            if (!pendingToolCallsMap.has(event.id)) {
              pendingToolCallsMap.set(event.id, { id: event.id, name: event.name, args: event.args });
            }
          } else if (event.type === "thought_delta") {
            process.stdout.write(`${colors.gray}${event.thought}${colors.reset}`);
            assistantReasoning += event.thought;
          }
        }

        console.log();
        const pendingToolCalls = Array.from(pendingToolCallsMap.values());

        // Save assistant turn with reasoning_content (required by DeepSeek R1)
        if (assistantText || assistantReasoning || pendingToolCalls.length > 0) {
          const assistantMsg: Message = { role: "assistant", content: assistantText };
          if (assistantReasoning) {
            assistantMsg.reasoning_content = assistantReasoning;
          }
          if (pendingToolCalls.length > 0) {
            assistantMsg.tool_calls = pendingToolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            }));
          }
          conversationHistory.push(assistantMsg);
        }

        // ─── Execute Tool Calls with User Approval ───────────────────────────
        if (pendingToolCalls.length > 0) {
          for (const tc of pendingToolCalls) {
            const toolDef = registry.get(tc.name);
            printToolApprovalHeader(tc.name, tc.args);

            // Compute & render color diff preview for code edits
            if (tc.name === "patch_file") {
              const filePath = String(tc.args.path || "");
              const targetCode = String(tc.args.target_code || "");
              const replacementCode = String(tc.args.replacement_code || "");
              const absPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
              const oldContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : "";

              try {
                const patchRes = applySurgicalPatch(oldContent, targetCode, replacementCode);
                const diff = computeUnifiedDiff(filePath, oldContent, patchRes.patchedContent);
                renderColorDiff(filePath, diff);
              } catch (diffErr: any) {
                console.log(`${colors.yellow}⚠ Could not compute preview diff: ${diffErr.message}${colors.reset}`);
              }
            } else if (tc.name === "write_file") {
              const filePath = String(tc.args.path || "");
              const newContent = String(tc.args.content || "");
              const absPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
              const oldContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : "";
              const diff = computeUnifiedDiff(filePath, oldContent, newContent);
              renderColorDiff(filePath, diff);
            }

            let approved = false;
            if (toolDef?.permissionLevel === "readonly") {
              console.log(`${colors.gray}[auto-approved: read-only]${colors.reset}`);
              approved = true;
            } else {
              const permColor = toolDef?.permissionLevel === "shell" ? colors.red : colors.yellow;
              console.log(`${permColor}Permission required: ${toolDef?.permissionLevel ?? "unknown"}${colors.reset}`);
              try {
                approved = await confirm({
                  message: `Execute ${colors.bold}${tc.name}${colors.reset}?`,
                  default: false,
                });
              } catch { approved = false; }
            }

            const abortCtrl = new AbortController();
            if (approved) {
              process.stdout.write(`${colors.gray}⟳ Running ${tc.name}...${colors.reset}`);
              const result = await executeTool(registry, tc as ToolCall, abortCtrl.signal);
              process.stdout.clearLine?.(0);
              process.stdout.cursorTo?.(0);

              if (result.isError) {
                console.log(`${colors.red}✗ ${tc.name} failed (${result.durationMs}ms):${colors.reset}\n${result.output}\n`);
              } else {
                console.log(`${colors.brightGreen}✓ ${tc.name} (${result.durationMs}ms)${colors.reset}`);
                const lines = result.output.split("\n");
                const preview = lines.slice(0, 15).join("\n");
                if (lines.length > 15) {
                  console.log(`${colors.gray}${preview}\n  ... (${lines.length - 15} more lines)${colors.reset}\n`);
                } else {
                  console.log(`${colors.gray}${preview}${colors.reset}\n`);
                }
              }

              conversationHistory.push({
                role: "tool",
                content: result.output,
                tool_call_id: tc.id,
              });
            } else {
              console.log(`${colors.yellow}⊘ Skipped: ${tc.name}${colors.reset}\n`);
              conversationHistory.push({
                role: "tool",
                content: `Tool execution was denied by user.`,
                tool_call_id: tc.id,
              });
            }
          }

          continueLoop = true;
        }

      } catch (err: any) {
        console.error(`\n${colors.red}❌ Error:${colors.reset}`, err?.message || String(err), "\n");
      }
    }
  }
}

main().catch(console.error);
