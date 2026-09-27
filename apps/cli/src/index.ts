#!/usr/bin/env node

/**
 * Inflynx Code CLI Agent — Full Agentic Loop with Surgical Patching & Diff Previews
 */

import fs from "fs";
import path from "path";
import { select, input, password, search, confirm } from "@inquirer/prompts";
import {
  createCredentialProfile,
  deleteCredentialProfile,
  getCredentialProfile,
  getProvider,
  listCredentialProfiles,
  loadEnv,
  MODEL_CATALOG,
  redactSecrets,
  REASONING_EFFORTS,
  refreshModelCatalog,
  resolveCredentialSecret,
  TOP_PROVIDERS,
  type CredentialProfile,
  type ProviderInfo,
  type ReasoningEffort,
  findWorkspaceRoot,
  sanitizeForTerminal,
  getProjectMcpConfigPaths,
  listTrustedMcpServers,
  revokeMcpServer,
  trustMcpServer,
} from "@inflynx/config";
import { ToolRegistry, CORE_TOOLS } from "@inflynx/tool-runtime";
import {
  type AgentMode,
  type AgentBudgetLevel,
  DEFAULT_EFFORT_PROFILES,
  MODE_CONFIGS,
  filterToolsForMode,
  PlanEngine,
  DebugEngine,
  GraphEngine,
  AgentOrchestrator,
  VerificationEngine,
  resolvePackageManager,
  FindingEngine,
  MODE_TOOL_PERMISSIONS,
  type ApprovalHandler,
  type ToolApprovalRequest,
} from "@inflynx/agent-core";
import { AgentEventBus, type PlanSpec } from "@inflynx/protocol";
import {
  CanonicalPathGuard,
  CommandPolicy,
  getShellAuditPath,
  getUserShellRulesPath,
  readShellAudit,
  resolvePreviewPath,
  reviewShellCommand,
  SHELL_AUDIT_RELATIVE_PATH,
} from "@inflynx/policy-engine";
import { HnswVectorStore } from "@inflynx/vector-store";
import { createSessionStore } from "@inflynx/session-store";
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
  { name: "/sessions",     value: "/sessions",     description: "List all saved agent sessions (SQLite & PostgreSQL)" },
  { name: "/resume",       value: "/resume",       description: "Restore & resume a past agent session: /resume <session_id>" },
  { name: "/tokens",       value: "/tokens",       description: "Show real-time session token usage telemetry & USD cost tracking" },
  { name: "/compact",      value: "/compact",      description: "Reclaim window space now: drop stale tool output and fold the oldest turns into a summary" },
  { name: "/context",      value: "/context",      description: "Alias for /compact — show and reclaim context-window usage" },
  { name: "/security",     value: "/security",     description: "Inspect path traversal guards, command policy & tool mode permissions" },
  { name: "/verify",       value: "/verify",       description: "Run the workspace build/typecheck/test gates and report which one failed (--dry-run to just list them)" },
  { name: "/undo",         value: "/undo",         description: "Revert the last turn that changed files, from its checkpoint (--list to see the history)" },
  { name: "/findings",     value: "/findings",     description: "Show evidence-first debug findings & codebase health score" },
  { name: "/vector",       value: "/vector",       description: "Semantic search across workspace using vector embeddings & cosine similarity" },
  { name: "/mode",         value: "/mode",         description: "Switch execution mode: ask | plan | agent | debug" },
  { name: "/graph",        value: "/graph",        description: "Generate codebase mind map, Mermaid diagram, SVG/PNG images & interactive HTML map" },
  { name: "/debug",        value: "/debug",        description: "CodeRabbit-style automated review, fault localization & report generation" },
  { name: "/plan",         value: "/plan",         description: "Generate structured .inflynx/PLAN.md for a task" },
  { name: "/execute-plan", value: "/execute-plan", description: "Approve & execute the current .inflynx/PLAN.md" },
  { name: "/provider",     value: "/provider",     description: "Select AI Provider & configure API key" },
  { name: "/model",        value: "/model",        description: "Select AI Model across providers" },
  { name: "/models",       value: "/models",       description: "List curated model capabilities and custom-model guidance" },
  { name: "/credentials", value: "/credentials",  description: "Manage OS-keychain BYOK credential profiles" },
  { name: "/effort",      value: "/effort",       description: "Set provider reasoning effort: none|minimal|low|medium|high|xhigh|max" },
  { name: "/thinking",    value: "/thinking",     description: "Alias for /effort — set thinking/reasoning effort" },
  { name: "/reasoning",   value: "/reasoning",    description: "Alias for /effort — set thinking/reasoning effort" },
  { name: "/budget",      value: "/budget",       description: "Set local agent loop budget: low|medium|high" },
  { name: "/tools",        value: "/tools",        description: "List available agent tools (filtered by active mode)" },
  { name: "/mcp",          value: "/mcp",          description: "Manage MCP connectors: list | add <name> | trust <id> | untrust <id>" },
  { name: "/skills",       value: "/skills",       description: "List & view discovered agent skills (.inflynx/skills)" },
  { name: "/create-skill", value: "/create-skill", description: "Interactively create a new reusable agent skill" },
  { name: "/index",        value: "/index",        description: "View workspace index summary & relevant files" },
  { name: "/clear",        value: "/clear",        description: "Clear terminal screen & conversation" },
  { name: "/help",         value: "/help",         description: "Show all available commands" },
  { name: "/exit",         value: "/exit",         description: "Exit Inflynx Code CLI agent" },
];

const KNOWN_COMMANDS = new Set(SLASH_COMMANDS.map((c) => c.value.slice(1)));

// ─── Helpers ───────────────────────────────────────────────────────────────────

type ActiveProviderInfo = Omit<ProviderInfo, "id"> & {
  id: ProviderInfo["id"] | "custom-openai-compatible";
};

const CUSTOM_OPENAI_COMPATIBLE_PROVIDER: ActiveProviderInfo = {
  id: "custom-openai-compatible",
  name: "Custom OpenAI-compatible",
  envKey: "OS keychain profile",
  defaultModel: "custom-model",
  models: [],
  adapter: "openai-chat",
  credentialRequired: true,
};

function getApiKeyForProvider(providerId: string): string | undefined {
  const provider = TOP_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return undefined;
  return process.env[provider.envKey];
}

// Note: conversation-history integrity recovery (stubbing unresponded tool_calls
// after a crash) used to be duplicated here. It now lives once, centrally, in
// `ExecutionContext.ensureHistoryIntegrity()` — called automatically by
// `AgentOrchestrator.runTurn()`'s error handler and by `resumeSession()`.

/**
 * Parses a JSON object a model produced as *data* (currently: an MCP server
 * proposal). Returns null rather than throwing, because the caller's next step is a
 * human confirmation screen and "the model's answer was not JSON" belongs there as
 * an outcome, not as a crash. Never eval, never a schema-less cast beyond this.
 */
function safeParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function truncateForPrompt(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function printToolApprovalHeader(toolName: string, args: Record<string, unknown>) {
  // Everything here was chosen by the model or by a remote tool, and it is printed
  // immediately before a human is asked to approve something. Terminal escapes in a tool
  // name or argument can rewrite that screen and make an arbitrary line look like the
  // prompt. Colors are still ours to add — only the foreign value is filtered. (N5)
  const name = sanitizeForTerminal(toolName);
  console.log();
  console.log(`${colors.bold}${colors.yellow}🔧 Tool Request: ${name}${colors.reset}`);
  console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
  for (const [k, v] of Object.entries(args)) {
    const raw = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "..." : String(v ?? "");
    console.log(`  ${colors.cyan}${sanitizeForTerminal(k)}${colors.reset}: ${colors.bold}${sanitizeForTerminal(raw)}${colors.reset}`);
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
      const profileCount = listCredentialProfiles().filter((profile) => profile.providerId === p.id).length;
      const hasKey = Boolean(process.env[p.envKey]) || profileCount > 0;
      const statusTag = hasKey
        ? `${colors.brightGreen}✓ ${profileCount ? `${profileCount} keychain profile${profileCount > 1 ? "s" : ""}` : "Environment"}${colors.reset}`
        : `${colors.red}✗ Missing ${p.envKey}${colors.reset}`;
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

  // Find true monorepo workspace root. This is now the ONLY root: it is passed to
  // the orchestrator, whose ToolExecutionGateway hands the same canonical guard to
  // every tool. The old `process.env.INFLYNX_WORKSPACE_ROOT` side-channel let tools
  // re-resolve paths against a process-wide root and disagree with the guard.
  const workspaceRoot = findWorkspaceRoot(process.cwd());

  // Init tool registry, MCP client manager, Skill manager, Plan engine & workspace indexer
  const registry = new ToolRegistry(CORE_TOOLS);
  const mcpManager = new McpClientManager();
  const mcpServers = await mcpManager.connectAll(workspaceRoot);
  const mcpToolsCount = mcpManager.registerToolsInto(registry);

  const skillManager = new SkillManager();
  const discoveredSkills = skillManager.discoverSkills(workspaceRoot);

  const planEngine = new PlanEngine(workspaceRoot);
  const debugEngine = new DebugEngine(workspaceRoot);
  const graphEngine = new GraphEngine(workspaceRoot);

  let workspaceIndex: WorkspaceIndex = buildWorkspaceIndex(workspaceRoot);

  // ─── Execution Mode ──────────────────────────────────────────────────────────
  let activeMode: AgentMode = "agent"; // Default: full agent mode

  const MODE_BADGE_COLORS: Record<AgentMode, string> = {
    ask: colors.blue,
    plan: colors.yellow,
    agent: colors.brightCyan,
    debug: colors.red,
  };

  function buildModeSystemPrompt(mode: AgentMode): string {
    const modeFile = path.join(workspaceRoot, MODE_CONFIGS[mode].systemPromptFile);
    const modePrompt = fs.existsSync(modeFile)
      ? fs.readFileSync(modeFile, "utf-8")
      : `You are Inflynx Agent in ${mode.toUpperCase()} MODE.`;

    const skillsBlock = skillManager.listSkills().length > 0
      ? `\n\nDiscovered Skills:\n` + skillManager.listSkills().map((s) => `- ${s.metadata.name} (${s.id}): ${s.metadata.description}`).join("\n")
      : "";

    // For agent mode, check if an active plan exists and inject it
    let planBlock = "";
    if (mode === "agent") {
      const activePlan = planEngine.loadActivePlan();
      if (activePlan && (activePlan.status === "IN_PROGRESS" || activePlan.status === "PENDING_APPROVAL")) {
        // `in_progress` belongs here too: the old filter was `pending` only, so the one
        // step the model was actively working on vanished from the list it was shown.
        const open = activePlan.steps.filter((s) => s.status === "pending" || s.status === "in_progress");
        if (open.length > 0) {
          const done = activePlan.steps.filter((s) => s.status === "completed").length;
          planBlock = `\n\nACTIVE PLAN (.inflynx/PLAN.md):\nGoal: ${activePlan.goal}\nStatus: ${activePlan.status}\nProgress: ${done}/${activePlan.steps.length} steps completed\nOpen steps:\n` +
            open.map((s) => `  Step ${s.id} [${s.status}]: ${s.description}${s.targetFiles.length ? ` (${s.targetFiles.join(", ")})` : ""}`).join("\n") +
            `\nAdvance it with the update_plan tool — do NOT edit PLAN.md with write_file or edit_file.`;
        }
      }
      if (activePlan && activePlan.warnings.length > 0) {
        console.log(`${colors.yellow}⚠ PLAN.md readability:${colors.reset} ${activePlan.warnings.join("; ")}`);
      }
    }

    // For debug mode, check if an active debug report exists
    let debugBlock = "";
    if (mode === "debug") {
      const activeReport = debugEngine.loadActiveReport();
      if (activeReport) {
        debugBlock = `\n\nLAST DEBUG REPORT (.inflynx/DEBUG_REPORT.md):\nHealth Score: ${activeReport.healthScore}/100\nTotal Issues: ${activeReport.totalIssues} (Critical: ${activeReport.criticalCount}, Security: ${activeReport.securityCount}, Performance: ${activeReport.performanceCount}, Minor: ${activeReport.minorCount})\n`;
      }
    }

    return [modePrompt, skillsBlock, planBlock, debugBlock, `\nCurrent workspace: ${workspaceRoot}`].filter(Boolean).join("");
  }

  // Determine active provider
  let activeProvider: ActiveProviderInfo = TOP_PROVIDERS[0];
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
  let activeCredentialProfile: CredentialProfile | undefined;
  const configuredProfileId = process.env.INFLYNX_CREDENTIAL_PROFILE;
  if (configuredProfileId) {
    const configuredProfile = getCredentialProfile(configuredProfileId);
    const configuredProvider = configuredProfile && getProvider(configuredProfile.providerId);
    if (configuredProfile && configuredProvider) {
      activeCredentialProfile = configuredProfile;
      activeProvider = configuredProvider;
      activeModel = process.env.INFLYNX_AGENT_MODEL || configuredProfile.defaultModel;
      activeApiKey = resolveCredentialSecret(configuredProfile);
    }
  }

  const envEffort = (process.env.INFLYNX_REASONING_EFFORT || process.env.INFLYNX_THINKING_EFFORT) as ReasoningEffort | undefined;
  let activeReasoningEffort: ReasoningEffort = envEffort && REASONING_EFFORTS.includes(envEffort) ? envEffort : "none";

  const envBudget = process.env.INFLYNX_AGENT_BUDGET as AgentBudgetLevel | undefined;
  let activeBudgetLevel: AgentBudgetLevel = envBudget && (["low", "medium", "high", "max"] as AgentBudgetLevel[]).includes(envBudget)
    ? envBudget
    : (activeReasoningEffort === "high" || activeReasoningEffort === "xhigh" || activeReasoningEffort === "max" ? "high" : "medium");

  displayWelcomeBanner(activeModel, activeProvider.id, workspaceRoot);
  const effortBadge = activeReasoningEffort !== "none"
    ? `${colors.brightCyan}${activeReasoningEffort}${colors.reset}`
    : `${colors.dim}off${colors.reset}`;
  console.log(
    `${colors.gray}Mode: ${MODE_BADGE_COLORS[activeMode]}[${activeMode}]${colors.reset}${colors.gray} | ` +
    `Thinking: [${effortBadge}${colors.gray}] | ` +
    `Budget: [${colors.brightGreen}${activeBudgetLevel}${colors.reset}${colors.gray}] (${DEFAULT_EFFORT_PROFILES[activeBudgetLevel].maxModelTurns} max turns) — ` +
    `Type /mode, /thinking or /budget${colors.reset}`
  );

  if (!activeApiKey) {
    console.log(`${colors.yellow}⚠ Warning: No API key for [${activeProvider.name}]. Use /provider to configure.${colors.reset}\n`);
  }

  console.log(`${colors.gray}⚡ Indexed ${workspaceIndex.totalFiles} workspace files (.gitignore aware) in ${workspaceRoot}${colors.reset}\n`);

  const sessionStore = createSessionStore(workspaceRoot);
  const eventBus = new AgentEventBus();

  // ─── Tool Approval Handler ───────────────────────────────────────────────────
  // Commands the user chose "allow for the rest of this session" for, so a repeated
  // build/test loop does not re-prompt every round. Exact-string, not prefix: "npm
  // run test" must not silently authorise "npm run test && rm -rf /".
  const sessionApprovedCommands = new Set<string>();

  // ApprovalProvider auto-approves read-only *core* tools before ever calling this —
  // this handler fires for readwrite/shell tools, MCP tools, and anything the shell
  // rule engine graded `ask`.
  const approvalHandler: ApprovalHandler = async (request: ToolApprovalRequest) => {
    const permColor = request.permissionLevel === "shell" ? colors.red : colors.yellow;
    const command = String(request.args?.command || "");
    const isShell = request.permissionLevel === "shell";

    if (isShell && sessionApprovedCommands.has(command)) {
      console.log(`${colors.gray}[allowed earlier for this session]${colors.reset}`);
      return true;
    }

    console.log(`${permColor}Permission required: ${request.permissionLevel}${colors.reset}`);
    if (request.shellReview) {
      // The structure itself was already printed with the tool.proposed header; here
      // only name the part that forced the prompt, so the decision is scannable.
      const escalations = request.shellReview.verdicts.filter((v) => v.decision !== "allow");
      for (const verdict of escalations) {
        console.log(`  ${colors.yellow}→ ${verdict.text}${colors.reset} ${colors.gray}— ${verdict.reason}${colors.reset}`);
      }
      if (request.shellReview.features.writeRedirections.length > 0) {
        console.log(
          `  ${colors.yellow}⚠ writes ${request.shellReview.features.writeRedirections.join(", ")} directly — ` +
          `no diff preview, no undo${colors.reset}`
        );
      }
      if (request.shellReview.features.substitutions.length > 0) {
        console.log(`  ${colors.yellow}⚠ also runs: ${request.shellReview.features.substitutions.join(" ; ")}${colors.reset}`);
      }
    } else if (!isShell) {
      printToolApprovalHeader(request.toolName, request.args as Record<string, unknown>);
    }

    // A fake-fix violation is not an ordinary approval: the human is being asked to
    // override a policy that already said no, so it has to look different on screen and
    // say what each rule caught. (backlog Phase 32)
    const overridePatch = Boolean(request.patchSafety && !request.patchSafety.safe);
    if (overridePatch) {
      console.log(`${colors.bold}${colors.red}⛔ The agent's edit was refused by policy. Approving this overrides an anti-fake-fix check.${colors.reset}`);
      for (const v of request.patchSafety!.violations) {
        console.log(`  ${colors.red}• ${sanitizeForTerminal(v.reason)}${colors.reset}`);
        console.log(`    ${colors.gray}[${v.rule}] ${sanitizeForTerminal(v.evidence)}${colors.reset}`);
      }
    }

    try {
      const choices = isShell
        ? [
            { name: "Yes, run this once", value: "once" },
            { name: `Yes, and allow \`${truncateForPrompt(command, 46)}\` for the rest of this session`, value: "session" },
            { name: "No — deny", value: "deny" },
          ]
        : overridePatch
          ? [
              { name: "No — let the agent fix the real problem", value: "deny" },
              { name: "Yes — I know it suppresses a check, apply it anyway", value: "once" },
            ]
          : [
              { name: "Yes, run this", value: "once" },
              { name: "No — deny", value: "deny" },
            ];

      const answer = await select({
        message: overridePatch
          ? `Override the fake-fix refusal for ${colors.bold}${sanitizeForTerminal(request.toolName)}${colors.reset}?`
          : `Execute ${colors.bold}${sanitizeForTerminal(request.toolName)}${colors.reset}?`,
        choices,
      });
      const approved = answer === "once" || answer === "session";
      if (answer === "session" && isShell) sessionApprovedCommands.add(command);
      if (!approved) console.log(`${colors.yellow}⊘ Denied: ${request.toolName}${colors.reset}\n`);
      return approved;
    } catch {
      // Ctrl+C / closed prompt is a refusal, never an implicit yes.
      console.log(`${colors.yellow}⊘ Skipped: ${request.toolName}${colors.reset}\n`);
      return false;
    }
  };

  // ─── Live Event Bus Rendering ────────────────────────────────────────────────
  // Everything the terminal prints during a turn is driven by AgentOrchestrator's
  // events — this is the single code path shared by every tool call, whether it
  // came from a plain user message, /debug, /plan, /execute-plan, or /mcp add.
  eventBus.on<{ toolName: string; permissionLevel: string; args: Record<string, unknown>; shellDecision?: string; shellSegments?: Array<{ text: string; decision: string; reason: string }>; patchSafetyRules?: string[]; patchSafetySummary?: string }>("tool.proposed", (evt) => {
    if (evt.payload.patchSafetyRules?.length) {
      console.log(`${colors.bold}${colors.red}⛔ refused by anti-fake-fix policy:${colors.reset} ${colors.gray}${evt.payload.patchSafetyRules.join(", ")}${colors.reset}`);
    }
    if (evt.payload.shellSegments?.length) {
      // Every shell call shows its parsed structure, including the ones the rules
      // cleared without asking — otherwise "what just ran?" has no answer on screen.
      const line = truncateForPrompt(String(evt.payload.args?.command || ""), 120);
      console.log(`${colors.bold}${colors.magenta}$${colors.reset} ${colors.bold}${sanitizeForTerminal(line)}${colors.reset}`);
      for (const verdict of evt.payload.shellSegments) {
        if (verdict.decision === "allow" && evt.payload.shellSegments.length === 1) continue;
        const color = verdict.decision === "deny" ? colors.red : verdict.decision === "ask" ? colors.yellow : colors.brightGreen;
        console.log(`  ${color}${verdict.decision}${colors.reset} ${colors.gray}${sanitizeForTerminal(verdict.text)} — ${sanitizeForTerminal(verdict.reason)}${colors.reset}`);
      }
    } else {
      printToolApprovalHeader(evt.payload.toolName, evt.payload.args);
    }

    // A preview is a courtesy, not a reason to read a file the guard would refuse. The
    // proposal text is untrusted until the tool actually runs. (backlog N6)
    const previewGuard = orchestrator ? orchestrator.getPathGuard() : null;

    if (evt.payload.toolName === "patch_file") {
      const filePath = String(evt.payload.args.path || "");
      const targetCode = String(evt.payload.args.target_code || "");
      const replacementCode = String(evt.payload.args.replacement_code || "");
      const resolved = resolvePreviewPath(previewGuard, filePath);
      if (!resolved.ok) {
        console.log(`${colors.yellow}⚠ No diff preview: ${resolved.reason}${colors.reset}`);
      } else {
        const oldContent = fs.existsSync(resolved.absPath) ? fs.readFileSync(resolved.absPath, "utf-8") : "";
        try {
          const patchRes = applySurgicalPatch(oldContent, targetCode, replacementCode);
          const shown = sanitizeForTerminal(resolved.displayName);
          const diff = computeUnifiedDiff(shown, oldContent, patchRes.patchedContent);
          renderColorDiff(shown, sanitizeForTerminal(diff));
        } catch (diffErr: any) {
          console.log(`${colors.yellow}⚠ Could not compute preview diff: ${sanitizeForTerminal(diffErr.message)}${colors.reset}`);
        }
      }
    } else if (evt.payload.toolName === "write_file") {
      const filePath = String(evt.payload.args.path || "");
      const newContent = String(evt.payload.args.content || "");
      const resolved = resolvePreviewPath(previewGuard, filePath);
      if (!resolved.ok) {
        console.log(`${colors.yellow}⚠ No diff preview: ${resolved.reason}${colors.reset}`);
      } else {
        try {
          const oldContent = fs.existsSync(resolved.absPath) ? fs.readFileSync(resolved.absPath, "utf-8") : "";
          const shown = sanitizeForTerminal(resolved.displayName);
          const diff = computeUnifiedDiff(shown, oldContent, newContent);
          renderColorDiff(shown, sanitizeForTerminal(diff));
        } catch (diffErr: any) {
          console.log(`${colors.yellow}⚠ Could not compute preview diff: ${sanitizeForTerminal(diffErr.message)}${colors.reset}`);
        }
      }
    }

    if (evt.payload.permissionLevel === "readonly") {
      console.log(`${colors.gray}[auto-approved: read-only]${colors.reset}`);
    }
  });

  eventBus.on<{ toolName: string }>("tool.started", (evt) => {
    process.stdout.write(`${colors.gray}⟳ Running ${sanitizeForTerminal(evt.payload.toolName)}...${colors.reset}`);
  });

  eventBus.on<{ toolName: string; isError: boolean; durationMs: number; outputSnippet: string }>("tool.output", (evt) => {
    process.stdout.clearLine?.(0);
    process.stdout.cursorTo?.(0);
    // The snippet is a foreign program's output — an MCP server, a shell command, the
    // contents of a cloned file. It is printed seconds before a human reads a prompt, so
    // it must not be able to move the cursor or rewrite the screen. (N5)
    const snippet = sanitizeForTerminal(evt.payload.outputSnippet);
    if (evt.payload.isError) {
      console.log(`${colors.red}✗ ${sanitizeForTerminal(evt.payload.toolName)} failed (${evt.payload.durationMs}ms):${colors.reset}\n${snippet}\n`);
    } else {
      console.log(`${colors.brightGreen}✓ ${sanitizeForTerminal(evt.payload.toolName)} (${evt.payload.durationMs}ms)${colors.reset}`);
      console.log(`${colors.gray}${snippet}${colors.reset}\n`);
    }
  });

  eventBus.on<{ text: string }>("model.text_delta", (evt) => {
    // The model's own text is untrusted too: it is a transcription of remote content and
    // can echo a sequence back that it read out of a file.
    process.stdout.write(sanitizeForTerminal(evt.payload.text));
  });

  eventBus.on<{ thought: string }>("model.thought_delta", (evt) => {
    process.stdout.write(`${colors.gray}${sanitizeForTerminal(evt.payload.thought)}${colors.reset}`);
  });

  eventBus.on("turn.started", () => {
    console.log();
    process.stdout.write(`${colors.brightCyan}⚡ Inflynx (${activeModel}):${colors.reset} `);
  });

  eventBus.on<{ error: string }>("turn.failed", (evt) => {
    console.error(`\n${colors.red}❌ Error:${colors.reset} ${evt.payload.error}\n`);
  });

  eventBus.on<{ reason: string }>("session.failed", (evt) => {
    console.error(`\n${colors.red}❌ Session budget exhausted:${colors.reset} ${evt.payload.reason}\n`);
  });

  eventBus.on<{ thresholdPercent: number; currentTurns: number; maxTurns: number; currentToolCalls: number; maxToolCalls: number }>(
    "budget.warning",
    (evt) => {
      console.log(
        `\n${colors.yellow}⚠ Budget warning (${evt.payload.thresholdPercent}%): ${evt.payload.currentTurns}/${evt.payload.maxTurns} turns, ${evt.payload.currentToolCalls}/${evt.payload.maxToolCalls} tool calls used.${colors.reset}`
      );
    }
  );

  // The plan progress line. `plan.updated` had been in the protocol since the event list
  // existed with nothing emitting it, which is a large part of why the plan feature read as
  // prose: the human's only view of progress was opening PLAN.md by hand.
  eventBus.on<{ plan?: PlanSpec; goal?: string; status?: string; completed?: number; total?: number }>(
    "plan.updated",
    (evt) => {
      const plan = evt.payload.plan;
      if (!plan) return;
      const done = plan.steps.filter((s) => s.status === "completed").length;
      const skipped = plan.steps.filter((s) => s.status === "skipped").length;
      const settled = done + skipped;
      const current = plan.steps.find((s) => s.status === "in_progress");
      const width = 20;
      const filled = plan.steps.length ? Math.round((settled / plan.steps.length) * width) : 0;
      console.log(
        `\n${colors.yellow}📋 plan${colors.reset} ${colors.gray}[${"█".repeat(filled)}${"░".repeat(width - filled)}]${colors.reset} ` +
        `${colors.brightGreen}${settled}/${plan.steps.length}${colors.reset} · ${sanitizeForTerminal(plan.goal)} (${plan.status})`
      );
      if (current) {
        console.log(`   ${colors.cyan}→ step ${current.id}: ${sanitizeForTerminal(current.title)}${colors.reset}`);
      }
    }
  );

  let orchestrator = await AgentOrchestrator.start(
    {
      workspaceRoot,
      providerId: activeProvider.id,
      model: activeModel,
      apiKey: activeApiKey || "",
      credentialProfileId: activeCredentialProfile?.id,
      modelAdapter: activeProvider.adapter,
      activeMode,
      systemPrompt: buildModeSystemPrompt(activeMode),
      reasoningEffort: activeReasoningEffort,
    },
    registry,
    eventBus,
    approvalHandler,
    activeBudgetLevel,
    sessionStore
  );

  // NOTE: the old `new ContextManager(128000)` lived here. It was never fed any
  // messages, so `/compact` reported 0 items forever and the 128000 had no
  // relationship to the selected model. Context relief now lives in the
  // orchestrator, driven by the model's actual window.

  // ─── Ctrl+C Interrupt ─────────────────────────────────────────────────────
  // During a turn this now genuinely stops it: `runTurn` holds one AbortSignal per
  // turn and checks that exact signal between tool calls (Phase 6), so pending
  // calls are skipped and the interrupted round is repaired before the next turn.
  // A second Ctrl+C exits the process outright.
  let turnInFlight = false;
  let interruptRequested = false;
  // One exit path, so a background shell can never survive a way out of the CLI.
  // `detached` children outlive an unclean parent by design; reaping here is the
  // only thing that guarantees a leftover `pnpm dev` is not holding port 3000 for
  // the next session. The count is reported, not assumed.
  const exitInflynx = (code: number, label: string) => {
    const { shellsStopped } = orchestrator.shutdown({ abortTurn: false });
    mcpManager.disconnectAll();
    if (shellsStopped > 0) {
      console.log(`${colors.yellow}⚠ Stopped ${shellsStopped} background shell(s) this session had started.${colors.reset}`);
    }
    console.log(`\n${colors.cyan}${label} 👋${colors.reset}\n`);
    process.exit(code);
  };

  process.on("SIGINT", () => {
    if (!turnInFlight) {
      exitInflynx(130, "Goodbye!");
    }
    if (interruptRequested) {
      console.log(`\n${colors.red}Second interrupt — exiting.${colors.reset}`);
      exitInflynx(130, "Goodbye!");
    }
    interruptRequested = true;
    orchestrator.abort();
    const running = orchestrator.runningShellCount();
    console.log(
      `\n${colors.yellow}⏹ Interrupting this turn — finishing the current step, then returning to the prompt. ` +
      `Ctrl+C again to exit.${colors.reset}` +
      (running > 0
        ? `\n${colors.gray}   ${running} background shell(s) keep running; shell_stop them or exit to clean up.${colors.reset}`
        : "")
    );
  });

  const switchToKnownModel = async (
    provider: ProviderInfo,
    model: string,
    apiKey: string,
    credentialProfile?: CredentialProfile,
    reasoningEffort?: ReasoningEffort
  ): Promise<void> => {
    const next = await orchestrator.switchModel({
      providerId: provider.id,
      model,
      apiKey,
      credentialProfileId: credentialProfile?.id,
      modelAdapter: provider.adapter,
      reasoningEffort,
    });
    orchestrator = next;
    activeProvider = provider;
    activeModel = model;
    activeApiKey = apiKey;
    activeCredentialProfile = credentialProfile;
  };

  const switchToCustomModel = async (profile: CredentialProfile, apiKey: string): Promise<void> => {
    const next = await orchestrator.switchModel({
      providerId: "custom-openai-compatible",
      model: profile.defaultModel,
      apiKey,
      credentialProfileId: profile.id,
      baseURL: profile.baseURL,
      modelAdapter: "openai-chat",
      allowUnauthenticated: !apiKey,
      allowLocalEndpoint: profile.allowLocalEndpoint,
      customCapabilities: profile.customCapabilities || { supportsTools: false, supportedEfforts: ["none"] },
      reasoningEffort: profile.customCapabilities?.supportedEfforts[0] || "none",
    });
    orchestrator = next;
    activeProvider = CUSTOM_OPENAI_COMPATIBLE_PROVIDER;
    activeModel = profile.defaultModel;
    activeApiKey = apiKey;
    activeCredentialProfile = profile;
  };

  // ─── REPL Loop ──────────────────────────────────────────────────────────────
  while (true) {
    // Mode-colored prompt badge
    const modeBadge = `${MODE_BADGE_COLORS[activeMode]}[${activeMode}]${colors.reset}`;
    let inputStr = await askUserPrompt(formatPrompt(workspaceRoot, modeBadge));
    if (!inputStr) continue;

    // Auto-prefix slash if user typed command name directly without leading /
    const trimmedInput = inputStr.trim();
    if (
      !trimmedInput.startsWith("/") &&
      (trimmedInput.startsWith("resume ") ||
       trimmedInput === "sessions" ||
       trimmedInput === "token" ||
       trimmedInput === "tokens" ||
       trimmedInput === "compact" ||
       trimmedInput === "context" ||
       trimmedInput === "security" ||
       trimmedInput === "policy" ||
       trimmedInput === "verify" ||
       trimmedInput === "findings" ||
       trimmedInput.startsWith("vector") ||
       trimmedInput === "mode" ||
       trimmedInput === "help")
    ) {
      inputStr = "/" + trimmedInput;
    }

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
          console.log(`  ${colors.cyan}${c.name.padEnd(16)}${colors.reset} ${colors.gray}— ${c.description}${colors.reset}`);
        }
        console.log(`\nActive Mode: ${MODE_BADGE_COLORS[activeMode]}[${activeMode}]${colors.reset} — Use /mode to switch\n`);
        continue;
      }

      // ─── /sessions & /resume Commands ─────────────────────────────────────────
      if (cmd === "sessions") {
        const sessionsList = await sessionStore.listSessions(workspaceRoot);
        if (sessionsList.length === 0) {
          console.log(`\n${colors.gray}No saved sessions found.${colors.reset}\n`);
        } else {
          console.log(`\n${colors.bold}📜 Saved Agent Sessions:${colors.reset}`);
          for (const s of sessionsList.slice(0, 10)) {
            const dateStr = new Date(s.updatedAt).toLocaleString();
            const badge = MODE_BADGE_COLORS[s.activeMode as AgentMode] || colors.cyan;
            const activeMark = s.sessionId === orchestrator.sessionId ? ` ${colors.brightMagenta}(ACTIVE)${colors.reset}` : "";
            console.log(`  ${colors.brightCyan}${s.sessionId}${colors.reset} | ${badge}[${s.activeMode}]${colors.reset} | ${colors.yellow}${s.model}${colors.reset} | ${colors.gray}${dateStr}${colors.reset}${activeMark}`);
          }
          console.log(`\n${colors.gray}Use /resume <session_id> to restore a session state.${colors.reset}\n`);
        }
        continue;
      }

      if (cmd === "resume" && parts[1]) {
        const targetId = parts[1].trim();
        const hydration = await sessionStore.getSessionHydration(targetId);

        if (hydration) {
          // AgentOrchestrator.resumeSession() re-hydrates conversation history
          // AND runs the tool-call integrity check internally — no manual
          // history rebuilding or stub-injection needed here anymore. It throws
          // (rather than returning null) if the session's provider has no API
          // key configured in the current environment.
          let resumed: AgentOrchestrator | null = null;
          try {
            resumed = await AgentOrchestrator.resumeSession(workspaceRoot, targetId, registry, eventBus, approvalHandler, sessionStore);
          } catch (err: any) {
            console.log(`\n${colors.red}✗ Cannot resume session: ${err?.message || String(err)}${colors.reset}\n`);
            continue;
          }
          if (!resumed) {
            console.log(`\n${colors.red}✗ Session not found: ${targetId}${colors.reset}\n`);
            continue;
          }
          orchestrator = resumed;
          activeMode = (hydration.session.activeMode as AgentMode) || "agent";
          const resumedProvider = TOP_PROVIDERS.find((p) => p.id === hydration.session.provider);
          if (resumedProvider) {
            activeProvider = resumedProvider;
            activeCredentialProfile = hydration.session.credentialProfileId
              ? getCredentialProfile(hydration.session.credentialProfileId)
              : undefined;
            activeApiKey = activeCredentialProfile
              ? resolveCredentialSecret(activeCredentialProfile)
              : getApiKeyForProvider(resumedProvider.id);
          }
          activeModel = hydration.session.model;

          // resumeSession() doesn't know about CLI-level mode prompts (skills,
          // active plan/debug-report blocks) — rebuild and inject it here.
          orchestrator.setSystemPrompt(buildModeSystemPrompt(activeMode));

          console.log(`\n${colors.brightGreen}✓ Session restored: ${targetId}${colors.reset}`);
          console.log(`  ${colors.gray}Loaded ${hydration.messages.length} messages into active context.${colors.reset}\n`);

          console.log(`${colors.gray}─── Restored Chat Transcript ─────────────────────────────────${colors.reset}`);
          for (const msg of hydration.messages) {
            if (msg.role === "user") {
              console.log(`\n${colors.bold}${colors.brightCyan}User:${colors.reset} ${sanitizeForTerminal(msg.content)}`);
            } else if (msg.role === "assistant") {
              if (msg.content) {
                console.log(`\n${colors.bold}${colors.brightMagenta}⚡ Inflynx (${hydration.session.model}):${colors.reset}\n${sanitizeForTerminal(msg.content)}`);
              }
            } else if (msg.role === "tool") {
              const snippet = (msg.content || "").split("\n").slice(0, 3).join("\n");
              console.log(`${colors.gray}🔧 Tool Output (${sanitizeForTerminal(msg.toolCallId || "tool")}): ${sanitizeForTerminal(snippet)}${colors.reset}`);
            }
          }
          console.log(`\n${colors.gray}─────────────────────────────────────────────────────────────${colors.reset}\n`);
        } else {
          console.log(`\n${colors.red}✗ Session not found: ${targetId}${colors.reset}\n`);
        }
        continue;
      }

      // ─── /tokens & /compact Commands ──────────────────────────────────────────
      if (cmd === "tokens" || cmd === "token") {
        // Sourced directly from BudgetManager (via the orchestrator) — the same
        // real, provider-computed usage numbers that get persisted to the DB,
        // instead of a second, separately-accumulated set of local counters.
        const budget = orchestrator.budget;
        const modelConfig = orchestrator.modelConfiguration;
        const totalTokens = budget.promptTokens + budget.completionTokens;

        console.log(`\n${colors.bold}📊 Active Session Token Telemetry & USD Cost:${colors.reset}`);
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
        console.log(`  ${colors.cyan}Configured Model:${colors.reset}   ${colors.yellow}${modelConfig.model}${colors.reset} (${activeProvider.name})`);
        if (modelConfig.actualModel && modelConfig.actualModel !== modelConfig.model) {
          console.log(`  ${colors.cyan}Served Model:${colors.reset}       ${colors.yellow}${modelConfig.actualModel}${colors.reset}`);
        }
        console.log(`  ${colors.cyan}Reasoning Effort:${colors.reset}   requested/resolved ${modelConfig.reasoningEffort}`);
        console.log(`  ${colors.cyan}Agent Budget:${colors.reset}       ${modelConfig.budgetLevel}`);
        console.log(`  ${colors.cyan}Prompt Tokens:${colors.reset}      ${budget.promptTokens.toLocaleString()}`);
        console.log(`  ${colors.cyan}Completion Tokens:${colors.reset}  ${budget.completionTokens.toLocaleString()}`);
        if (budget.reasoningTokens > 0) {
          console.log(`  ${colors.cyan}Reasoning Tokens:${colors.reset}   ${budget.reasoningTokens.toLocaleString()}`);
        }
        console.log(`  ${colors.cyan}Total Tokens:${colors.reset}       ${totalTokens.toLocaleString()}`);
        console.log(`  ${colors.brightGreen}Estimated Cost:${colors.reset}     $${budget.estimatedCostUsd.toFixed(6)} USD`);
        if (budget.contextWindow > 0) {
          console.log(`  ${colors.cyan}Model Window:${colors.reset}        ${budget.contextWindow.toLocaleString()} tokens`);
          console.log(
            `  ${colors.cyan}Context Used:${colors.reset}        ${budget.projectedContextTokens.toLocaleString()} projected ` +
            `${colors.brightCyan}(${budget.contextUtilizationPercent}% incl. output headroom)${colors.reset}`
          );
          console.log(
            `  ${colors.cyan}Window Policy:${colors.reset}       ${orchestrator.contextStrategy}` +
            `${orchestrator.contextStrategy === "evict" ? " (stale tool output is dropped automatically; set INFLYNX_CONTEXT_STRATEGY=compact for summarization)" : ""}`
          );
        } else {
          console.log(`  ${colors.yellow}Context Used:${colors.reset}        window unknown for this model`);
        }
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}\n`);
        continue;
      }

      if (cmd === "compact" || cmd === "context") {
        const before = orchestrator.budget;
        // An explicit /compact is the user asking for the expensive tier too, so it
        // overrides the opt-in `compact` default (but never `off`).
        const relief = await orchestrator.compactContextNow({ summarize: true });
        const after = orchestrator.budget;

        console.log(`\n${colors.bold}🧹 Context Window Relief:${colors.reset}`);
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
        console.log(`  ${colors.cyan}Model Window:${colors.reset}        ${after.contextWindow.toLocaleString()} tokens`);
        console.log(`  ${colors.cyan}Before:${colors.reset}                ${before.projectedContextTokens.toLocaleString()} projected (${before.contextUtilizationPercent}%)`);
        console.log(`  ${colors.brightGreen}After:${colors.reset}                 ${after.projectedContextTokens.toLocaleString()} projected (${after.contextUtilizationPercent}%)`);
        console.log(
          `  ${colors.cyan}Evicted:${colors.reset}               ${relief.dropped} stale tool result(s)`
        );
        console.log(
          `  ${colors.cyan}Summarized:${colors.reset}            ` +
          (relief.summarized > 0
            ? `oldest turns folded into one summary`
            : `no summary (nothing safe to fold, strategy is off, or the model declined)`)
        );
        console.log(`  ${colors.cyan}Freed:${colors.reset}                 ${relief.charsFreed.toLocaleString()} chars`);
        if (relief.dropped === 0 && relief.summarized === 0) {
          console.log(
            `  ${colors.yellow}Nothing to drop — the remaining turns are all recent, and the older ones are` +
            ` too small to be worth folding.${colors.reset}\n` +
            `  ${colors.gray}Auto-summarization is gated off by design; set INFLYNX_CONTEXT_STRATEGY=compact to` +
            ` enable it mid-session.${colors.reset}`
          );
        }
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}\n`);
        continue;
      }

      // ─── /security Command ───────────────────────────────────────────────────
      if (cmd === "security" || cmd === "policy") {
        const allowedPermissions = MODE_TOOL_PERMISSIONS[activeMode] || [];

        console.log(`\n${colors.bold}🛡️ Security Policy & Tool Gateway HUD:${colors.reset}`);
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
        console.log(`  ${colors.cyan}Workspace Root Boundary:${colors.reset} ${workspaceRoot}`);
        console.log(`  ${colors.cyan}Path Guard Status:${colors.reset}       ${colors.brightGreen}ACTIVE (fs.realpathSync symlink defense)${colors.reset}`);
        console.log(`  ${colors.cyan}Active Mode:${colors.reset}             ${MODE_BADGE_COLORS[activeMode]}[${activeMode}]${colors.reset}`);
        console.log(`  ${colors.cyan}Allowed Tool Levels:${colors.reset}     ${allowedPermissions.join(", ")}`);
        const offered = filterToolsForMode(registry.list(), activeMode);
        const externalOffered = offered.filter((t) => t.origin === "mcp" || t.origin === "plugin");
        console.log(
          `  ${colors.cyan}Third-party tools:${colors.reset}       ` +
          `${externalOffered.length > 0 ? `${colors.brightMagenta}${externalOffered.length} available, each needs approval` : `${colors.gray}not offered in [${activeMode}] mode`}${colors.reset}`
        );

        // Shell policy, reported from the engine rather than described from memory —
        // a HUD that recites what a control "does" is how this project ended up
        // advertising sandbox profiles it did not have.
        const sample = reviewShellCommand("rm -rf ./build && echo done");
        console.log(`  ${colors.cyan}Shell policy:${colors.reset}           ${colors.yellow}parse + classify + human approval${colors.reset}`);
        console.log(
          `  ${colors.cyan}  worked example:${colors.reset}         ${colors.gray}${sample.command}${colors.reset} → ${
            sample.decision === "allow" ? colors.brightGreen : sample.decision === "deny" ? colors.red : colors.yellow
          }${sample.decision}${colors.reset} (${sample.headline})`
        );
        const rulesFile = getUserShellRulesPath();
        console.log(
          `  ${colors.cyan}  your rules:${colors.reset}          ${fs.existsSync(rulesFile) ? `${colors.brightGreen}${rulesFile}${colors.reset}` : `${colors.gray}${rulesFile} (none — built-in rules only)${colors.reset}`}`
        );

        const auditLog = getShellAuditPath(workspaceRoot);
        const recentShell = readShellAudit(workspaceRoot, 3);
        const auditPad = `${colors.gray}${" ".repeat(21)}${colors.reset}`;
        console.log(
          `  ${colors.cyan}Shell audit log:${colors.reset}        ` +
          (recentShell.length === 0
            ? `${colors.gray}${fs.existsSync(auditLog) ? "empty" : "no entries yet"} — ${SHELL_AUDIT_RELATIVE_PATH}${colors.reset}`
            : recentShell
                .map((entry) =>
                  `${entry.decision === "allow" ? colors.brightGreen : entry.decision === "deny" ? colors.red : colors.yellow}` +
                  `${entry.approvedBy}${colors.reset} "${truncateForPrompt(entry.command, 28)}"`
                )
                .join(`\n${auditPad}`))
        );

        const awaitingTrust = mcpManager.listServers().filter((s) => s.status === "needs-trust");
        console.log(
          `  ${colors.cyan}MCP trust:${colors.reset}              ` +
          (awaitingTrust.length === 0
            ? `${colors.gray}no repository-defined server awaiting trust${colors.reset}`
            : `${colors.brightCyan}${awaitingTrust.length} not trusted (from repo config): ${awaitingTrust.map((s) => s.config.id).join(", ")}${colors.reset}`)
        );
        console.log(`  ${colors.cyan}Context strategy:${colors.reset}       ${orchestrator.contextStrategy}`);
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}\n`);
        continue;
      }

      // ─── /undo Command — turn checkpoints (backlog Phase 30) ─────────────────
      if (cmd === "undo") {
        const arg = parts.slice(1).join("").trim();
        const history = orchestrator.listCheckpoints();

        if (arg === "--list" || arg === "-l") {
          if (history.length === 0) {
            console.log(`\n  ${colors.gray}No checkpointed file changes in this session.${colors.reset}\n`);
            continue;
          }
          console.log(`\n${colors.bold}🕘 Checkpointed turns (newest first):${colors.reset}`);
          for (const c of history.slice(0, 10)) {
            const mark = c.undone ? `${colors.gray}↩ undone${colors.reset}` : `${colors.yellow}• live${colors.reset}`;
            console.log(
              `  ${mark} ${colors.gray}${new Date(c.at).toLocaleTimeString()}${colors.reset} ` +
              `${c.files.length} file(s): ${colors.brightCyan}${c.files.slice(0, 4).join(", ")}${colors.reset}` +
              `${c.files.length > 4 ? ` +${c.files.length - 4} more` : ""}`
            );
            console.log(`      ${colors.gray}${c.label}${colors.reset}`);
          }
          console.log(`\n  ${colors.gray}Use /undo to revert the newest live one.${colors.reset}\n`);
          continue;
        }

        const target = history.find((c) => !c.undone);
        if (!target) {
          console.log(`\n  ${colors.yellow}Nothing to undo — this session has not changed any files.${colors.reset}\n`);
          continue;
        }
        console.log(`\n${colors.bold}↩ Revert this turn?${colors.reset}`);
        console.log(`  ${colors.gray}${new Date(target.at).toLocaleString()} — ${target.label}${colors.reset}`);
        for (const f of target.files) console.log(`    ${colors.brightCyan}${f}${colors.reset}`);

        const ok = await confirm({ message: "Undo these files back to their pre-turn content?", default: false }).catch(() => false);
        if (!ok) {
          console.log(`\n  ${colors.gray}Kept as-is — nothing was changed.${colors.reset}\n`);
          continue;
        }
        const res = orchestrator.undoLastTurn();
        if (!res) {
          console.log(`\n  ${colors.yellow}No checkpoint was available.${colors.reset}\n`);
          continue;
        }
        for (const f of res.restored) console.log(`  ${colors.brightGreen}✓ restored${colors.reset} ${f}`);
        for (const c of res.conflicts) console.log(`  ${colors.red}✗ left alone${colors.reset}    ${c.path} — ${c.reason}`);
        console.log(
          res.conflicts.length > 0
            ? `\n  ${colors.yellow}${res.restored.length} reverted, ${res.conflicts.length} protected from overwrite.` +
              ` Those files were changed by someone else after the turn — re-read them before continuing.${colors.reset}\n`
            : `\n  ${colors.brightGreen}Turn reverted.${colors.reset}\n`
        );
        continue;
      }

      // ─── /verify Command ────────────────────────────────────────────────────
      if (cmd === "verify") {
        const only = parts.slice(1).join("").trim();
        // `/verify` used to print the discovered checks and a "✓ READY" badge for
        // each, then run nothing — the command reported readiness as if it were a
        // result. It now actually executes them; `--dry-run` keeps the old listing
        // for when you only want to see what would be gated.
        const dryRun = only === "--dry-run" || only === "-n";
        const verifier = new VerificationEngine("cli_verification", eventBus, { depth: "deep" });
        const checks = verifier.discoverWorkspaceChecks(workspaceRoot);
        const pm = resolvePackageManager(workspaceRoot);

        console.log(`\n${colors.bold}🧪 Verification Engine — ${checks.length} check(s) via ${pm.manager}${colors.reset}`);
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
        console.log(`  ${colors.cyan}Runner:${colors.reset}               ${pm.manager} ${colors.gray}(${pm.reason})${colors.reset}`);
        for (const c of checks) {
          const label = `${c.command} ${c.args.join(" ")}`;
          console.log(
            `  • ${colors.bold}${c.name.padEnd(26)}${colors.reset}` +
            `${c.isGate ? colors.red + "[GATE]" + colors.reset : colors.gray + "[advisory]" + colors.reset} ${label} ` +
            `${colors.gray}≤${Math.round(c.timeoutMs / 1000)}s${colors.reset}`
          );
        }
        if (checks.length === 0) {
          console.log(`  ${colors.yellow}No typecheck/build/test script discovered — nothing can be verified here.${colors.reset}`);
          console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}\n`);
          continue;
        }
        if (dryRun) {
          console.log(`  ${colors.gray}Dry run: nothing executed. Re-run /verify to run them.${colors.reset}`);
          console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}\n`);
          continue;
        }

        const startedAt = Date.now();
        const summary = await verifier.runAllChecks(workspaceRoot, AbortSignal.timeout(30 * 60_000));
        for (const r of summary.results) {
          const icon = r.passed ? `${colors.brightGreen}✓ PASS` : `${colors.red}✗ FAIL`;
          console.log(`  ${icon}${colors.reset} ${r.checkName.padEnd(26)} ${colors.gray}${r.durationMs.toLocaleString()}ms · exit ${r.exitCode ?? "-"}${colors.reset}`);
          for (const e of r.parsedErrors.slice(0, 6)) {
            console.log(`      ${colors.gray}${(e.rawOutput || e.message).slice(0, 160)}${colors.reset}`);
          }
          if (r.parsedErrors.length > 6) {
            console.log(`      ${colors.gray}…and ${r.parsedErrors.length - 6} more diagnostic(s)${colors.reset}`);
          }
          if (!r.passed && !r.parsedErrors.length && r.stdout.trim()) {
            // Still show something: a failing command with no parseable diagnostics
            // is otherwise a blank wall.
            console.log(`      ${colors.gray}${r.stdout.trim().split("\n").slice(0, 6).join("\n      ").slice(0, 900)}${colors.reset}`);
          }
          if (!r.passed) break;
        }
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
        console.log(
          `  ${summary.passed ? colors.brightGreen : colors.red}${summary.summaryMessage}${colors.reset} ` +
          `${colors.gray}(${(Date.now() - startedAt).toLocaleString()}ms)${colors.reset}\n`
        );
        continue;
      }

      // ─── /findings Command ──────────────────────────────────────────────────
      if (cmd === "findings") {
        const findingEngine = new FindingEngine();
        const score = findingEngine.calculateHealthScore();
        const verifiedList = findingEngine.getFindings().filter((f) => f.verificationStatus === "reproduced");

        console.log(`\n${colors.bold}🔍 Evidence-First Debug Findings & Health Score:${colors.reset}`);
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
        console.log(`  ${colors.cyan}Codebase Health Score:${colors.reset}  ${colors.brightGreen}${score}/100${colors.reset}`);
        console.log(`  ${colors.cyan}Verified Findings:${colors.reset}     ${verifiedList.length}`);
        console.log(`  ${colors.cyan}Total Registered:${colors.reset}      ${findingEngine.getFindings().length}`);
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}\n`);
        continue;
      }

      // ─── /vector Command ────────────────────────────────────────────────────
      if (cmd === "vector") {
        const queryStr = parts.slice(1).join(" ") || "CanonicalPathGuard";
        const vectorStore = new HnswVectorStore(workspaceRoot);
        const results = vectorStore.searchByText(queryStr, 3);

        console.log(`\n${colors.bold}📐 HNSW Vector Semantic Search Results for "${queryStr}":${colors.reset}`);
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}`);
        if (results.length === 0) {
          console.log(`  ${colors.gray}No vector matches found. Search index is updating...${colors.reset}`);
        } else {
          for (const r of results) {
            const lineInfo = r.chunk.startLine ? `:${r.chunk.startLine}-${r.chunk.endLine}` : "";
            const snippet = (r.chunk.content || "").split("\n")[0].slice(0, 80);
            console.log(`  • ${colors.brightCyan}${r.chunk.filePath}${lineInfo}${colors.reset} ${colors.yellow}(score=${r.score.toFixed(2)})${colors.reset}`);
            console.log(`    ${colors.gray}${snippet}${colors.reset}`);
          }
        }
        console.log(`${colors.gray}${"─".repeat(52)}${colors.reset}\n`);
        continue;
      }

      // ─── /mode Command ────────────────────────────────────────────────────────
      if (cmd === "mode") {
        const requestedMode = parts[1]?.toLowerCase() as AgentMode | undefined;

        if (requestedMode && ["ask", "plan", "agent", "debug"].includes(requestedMode)) {
          // Direct switch
          activeMode = requestedMode;
        } else {
          // Interactive dropdown
          try {
            const picked = await select({
              message: "Select Execution Mode:",
              choices: [
                { name: `💬 ask   — Read-only advisory & code explanation (no mutations)`, value: "ask" },
                { name: `📋 plan  — Research codebase & generate structured .inflynx/PLAN.md`, value: "plan" },
                { name: `⚡ agent — Full autonomous coding (patch, shell, MCP tools)`, value: "agent" },
                { name: `🐞 debug — CodeRabbit-style automated review, fault localization & report generation`, value: "debug" },
              ],
              default: activeMode,
            });
            activeMode = picked as AgentMode;
          } catch { console.log(); continue; }
        }

        // Propagate mode + rebuilt system prompt to the live orchestrator
        orchestrator.setMode(activeMode);
        orchestrator.setSystemPrompt(buildModeSystemPrompt(activeMode));

        const modeDescriptions: Record<AgentMode, string> = {
          ask: "Read-only advisor — will explain & analyze code, no file changes.",
          plan: "Architect mode — will research codebase & generate .inflynx/PLAN.md.",
          agent: "Full execution mode — all tools enabled, autonomous coding.",
          debug: "CodeRabbit debug mode — fault localization, surgical patches & .inflynx/DEBUG_REPORT.md generation.",
        };
        console.log(`\n${MODE_BADGE_COLORS[activeMode]}✓ Switched to [${activeMode}] mode${colors.reset}`);
        console.log(`  ${colors.gray}${modeDescriptions[activeMode]}${colors.reset}\n`);
        continue;
      }

      // ─── /debug Command ───────────────────────────────────────────────────────
      if (cmd === "debug") {
        const subCmd = parts[1]?.toLowerCase();

        if (subCmd === "report") {
          const report = debugEngine.loadActiveReport();
          if (!report) {
            console.log(`\n${colors.gray}No active debug report at .inflynx/DEBUG_REPORT.md. Run /debug <task> to generate one.${colors.reset}\n`);
          } else {
            console.log(`\n${colors.bold}🐞 Debug & Code Review Report:${colors.reset}`);
            console.log(`  Health Score: ${colors.brightGreen}${report.healthScore}/100${colors.reset}`);
            console.log(`  Total Issues: ${colors.cyan}${report.totalIssues}${colors.reset} (Critical: ${colors.red}${report.criticalCount}${colors.reset}, Security: ${colors.yellow}${report.securityCount}${colors.reset}, Performance: ${colors.brightCyan}${report.performanceCount}${colors.reset}, Minor: ${colors.gray}${report.minorCount}${colors.reset})`);
            console.log(`  Report Path: ${colors.dim}${report.reportPath}${colors.reset}\n`);
          }
          continue;
        }

        if (subCmd === "history") {
          const history = debugEngine.listHistory();
          if (history.length === 0) {
            console.log(`\n${colors.gray}No archived debug reports in .inflynx/reports/${colors.reset}\n`);
          } else {
            console.log(`\n${colors.bold}🐞 Archived Debug Reports:${colors.reset}`);
            for (const [i, r] of history.entries()) {
              console.log(`  ${colors.cyan}${i + 1}. ${r.filename}${colors.reset} ${colors.gray}(${r.mtime.toLocaleString()})${colors.reset}`);
            }
            console.log();
          }
          continue;
        }

        // Trigger debug mode for given command or task
        const debugTask = parts.slice(1).join(" ");
        activeMode = "debug";
        orchestrator.setMode("debug");
        orchestrator.setSystemPrompt(buildModeSystemPrompt("debug"));
        console.log(`\n${colors.red}🐞 Switched to [debug] mode${colors.reset}`);

        if (debugTask) {
          console.log(`${colors.gray}Executing CodeRabbit review & fault localization for: "${debugTask}"...${colors.reset}\n`);
          inputStr = [
            `Perform a deep CodeRabbit-style code review and debugging audit for: "${debugTask}".`,
            `1. Run appropriate tools (e.g. execute_shell, search_files, read_file) to capture logs and locate issues.`,
            `2. Analyze critical bugs, security risks, performance bottlenecks, and minor nits.`,
            `3. Apply surgical patches where appropriate using patch_file.`,
            `4. Re-verify fixes using execute_shell.`,
            `5. Generate a comprehensive Markdown report saved to .inflynx/DEBUG_REPORT.md following the mandatory schema in your system prompt.`,
          ].join("\n");
        } else {
          console.log(`${colors.gray}Type your debug goal, error log, or command to test (e.g. /debug pnpm build)...${colors.reset}\n`);
          continue;
        }
      }

      // ─── /graph Command ───────────────────────────────────────────────────────
      if (cmd === "graph" || cmd === "mindmap") {
        console.log(`\n${colors.brightCyan}⚡ Generating Codebase Mind Map & Architecture Knowledge Graph...${colors.reset}`);
        try {
          const res = await graphEngine.generateGraph();
          console.log(`\n${colors.brightGreen}✓ Architecture Graph & Mind Map Generated!${colors.reset}`);
          console.log(`  📄 Mermaid Source: ${colors.cyan}${res.graphMdPath}${colors.reset}`);
          console.log(`  🖼  SVG Graphic:    ${colors.cyan}${res.svgPath}${colors.reset}`);
          console.log(`  🖼  PNG Image:      ${colors.cyan}${path.join(workspaceRoot, ".inflynx", "graph.png")}${colors.reset}`);
          console.log(`  🌐 Interactive Map: ${colors.brightMagenta}${res.htmlPath}${colors.reset}`);
          console.log(`\n${colors.gray}Tip: Open .inflynx/graph.html in your browser for interactive zoom/pan visualizer!${colors.reset}\n`);
        } catch (err: any) {
          console.log(`${colors.red}✗ Failed to generate graph: ${err.message}${colors.reset}\n`);
        }
        continue;
      }

      // ─── /plan Command ────────────────────────────────────────────────────────
      if (cmd === "plan") {
        const subCmd = parts[1]?.toLowerCase();

        if (subCmd === "history") {
          const history = planEngine.listHistory();
          if (history.length === 0) {
            console.log(`\n${colors.gray}No archived plans found in .inflynx/plans/${colors.reset}\n`);
          } else {
            console.log(`\n${colors.bold}📋 Plan History:${colors.reset}`);
            for (const [i, p] of history.entries()) {
              console.log(`  ${colors.cyan}${i + 1}. ${p.filename}${colors.reset} ${colors.gray}(${p.mtime.toLocaleString()})${colors.reset}`);
            }
            console.log();
          }
          continue;
        }

        if (subCmd === "restore" && parts[2]) {
          const filename = parts.slice(2).join(" ");
          const ok = planEngine.restorePlan(filename);
          if (ok) {
            console.log(`\n${colors.brightGreen}✓ Plan restored: ${filename}${colors.reset}\n`);
          } else {
            console.log(`\n${colors.red}✗ Plan not found: ${filename}${colors.reset}\n`);
          }
          continue;
        }

        // /plan <task> — trigger plan mode with the task as input
        const taskGoal = parts.slice(1).join(" ");
        if (taskGoal) {
          activeMode = "plan";
          orchestrator.setMode("plan");
          orchestrator.setSystemPrompt(buildModeSystemPrompt("plan"));
          console.log(`\n${colors.yellow}📋 Switched to [plan] mode for task: "${taskGoal}"${colors.reset}`);
          console.log(`${colors.gray}Agent will research codebase and generate .inflynx/PLAN.md...${colors.reset}\n`);
          inputStr = `Create a detailed implementation plan for the following task: "${taskGoal}".\nFollow all 5 planning phases defined in your system prompt. Write the final plan to .inflynx/PLAN.md.`;
          // Proceed to LLM execution loop below
        } else {
          // Show current plan if it exists
          const active = planEngine.loadActivePlan();
          if (active) {
            console.log(`\n${colors.bold}📋 Active Plan: ${active.goal}${colors.reset}`);
            console.log(`  Status: ${colors.cyan}${active.status}${colors.reset}  Complexity: ${active.complexity}  Steps: ${active.steps.length}`);
            const done = active.steps.filter((s) => s.status === "completed").length;
            console.log(`  Progress: ${colors.brightGreen}${done}${colors.reset}/${active.steps.length} steps completed\n`);
            for (const s of active.steps) {
              const icon = { completed: "✅", in_progress: "⏳", pending: "⬜", failed: "❌", skipped: "⏭" }[s.status];
              const riskColor = s.risk === "HIGH" ? colors.red : s.risk === "MEDIUM" ? colors.yellow : colors.gray;
              console.log(`  ${icon} Step ${s.id}: ${s.description} ${riskColor}[${s.risk}]${colors.reset}`);
              if (s.targetFiles.length > 0) console.log(`      ${colors.gray}target: ${s.targetFiles.join(", ")}${colors.reset}`);
              if (s.dependencies.length > 0) console.log(`      ${colors.gray}depends on: ${s.dependencies.join(", ")}${colors.reset}`);
            }
            console.log(`\n${colors.gray}Run /execute-plan to start execution, or /plan history to see past plans.${colors.reset}\n`);
          } else {
            console.log(`\n${colors.gray}No active plan. Run \/plan <task description> to generate one.${colors.reset}\n`);
          }
          continue;
        }
      }

      // ─── /execute-plan Command ────────────────────────────────────────────────
      if (cmd === "execute-plan") {
        const active = planEngine.loadActivePlan();
        if (!active) {
          console.log(`\n${colors.red}✗ No active plan found at .inflynx/PLAN.md${colors.reset}`);
          console.log(`${colors.gray}Run /plan <task> to generate one first.${colors.reset}\n`);
          continue;
        }

        const pending = active.steps.filter((s) => s.status === "pending");
        if (pending.length === 0) {
          console.log(`\n${colors.brightGreen}✓ Plan already completed — all ${active.steps.length} steps done!${colors.reset}\n`);
          continue;
        }

        // Show approval HUD
        console.log(`\n${colors.bold}╔══════════════════════════════════════════╗${colors.reset}`);
        console.log(`${colors.bold}║  📋 Plan: ${active.goal.slice(0, 28).padEnd(29)} ║${colors.reset}`);
        console.log(`${colors.bold}║  Complexity: ${active.complexity.padEnd(9)} Pending: ${String(pending.length).padEnd(12)} ║${colors.reset}`);
        console.log(`${colors.bold}╠══════════════════════════════════════════╣${colors.reset}`);
        console.log(`${colors.bold}║  ${colors.brightGreen}[Y]${colors.reset}${colors.bold} Approve & Execute in Agent Mode     ║${colors.reset}`);
        console.log(`${colors.bold}║  ${colors.yellow}[N]${colors.reset}${colors.bold} Abort — do not execute               ║${colors.reset}`);
        console.log(`${colors.bold}╚══════════════════════════════════════════╝${colors.reset}\n`);

        try {
          const approved = await confirm({ message: "Approve and execute plan?", default: true });
          if (!approved) {
            console.log(`${colors.yellow}⊘ Plan execution aborted.${colors.reset}\n`);
            continue;
          }
        } catch { continue; }

        // Switch to agent mode and inject plan execution directive
        activeMode = "agent";
        planEngine.updatePlanStatus("IN_PROGRESS");
        orchestrator.setMode("agent");
        orchestrator.setSystemPrompt(buildModeSystemPrompt("agent"));
        console.log(`\n${colors.brightCyan}⚡ Switched to [agent] mode — executing plan step by step...${colors.reset}\n`);

        inputStr = [
          `Execute the approved plan from .inflynx/PLAN.md step by step.`,
          `Goal: "${active.goal}"`,
          `The plan has ${pending.length} pending steps. Execute each step in order:`,
          ...pending.map((s) => `- Step ${s.id}: ${s.description}${s.targetFiles.length ? ` (target: ${s.targetFiles.join(", ")})` : ""}`),
          `After each step succeeds, run its verification command and mark it complete.`,
          `Publish progress with the update_plan tool at the start and end of every step — the human watches that, not PLAN.md.`,
          `Show progress as: ✅ Step N: [description] [DONE in Xs]`,
          `If a step fails after 2 retries, report it and ask the user for guidance.`,
        ].join("\n");
        // Proceed to LLM execution loop
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
        const allTools = registry.list();
        const filteredTools = filterToolsForMode(allTools, activeMode);
        const blockedNames = new Set(allTools.filter(t => !filteredTools.some(f => f.name === t.name)).map(t => t.name));
        console.log(`\n${colors.bold}Agent Tools — Mode: ${MODE_BADGE_COLORS[activeMode]}[${activeMode}]${colors.reset}${colors.bold} (${filteredTools.length}/${allTools.length} active):${colors.reset}`);
        for (const t of allTools) {
          const perm = t.permissionLevel === "shell" ? colors.red : t.permissionLevel === "readwrite" ? colors.yellow : colors.brightGreen;
          const originTag = t.origin === "mcp" ? `${colors.brightMagenta}[MCP:${t.serverName}]${colors.reset} ` : "";
          const blocked = blockedNames.has(t.name) ? `${colors.red}[BLOCKED in ${activeMode} mode]${colors.reset} ` : "";
          console.log(`  ${blocked ? colors.dim : colors.cyan}${t.name.padEnd(30)}${colors.reset} ${originTag}${blocked}${perm}[${t.permissionLevel}]${colors.reset}  ${colors.gray}${t.description}${colors.reset}`);
        }
        console.log();
        continue;
      }

      if (cmd === "mcp") {
        const subCmd = parts[1]?.toLowerCase();
        const query = parts.slice(2).join(" ");

        if (subCmd === "trust" || subCmd === "untrust") {
          // Trust is recorded against the exact command line, so reviewing here means
          // reviewing what will actually run — not a name in a file.
          const pending = mcpManager.listServers().filter((s) => s.config.id === query.trim());
          if (pending.length === 0) {
            console.log(`\n${colors.yellow}No configured MCP server named "${query}".${colors.reset}\n`);
            continue;
          }
          for (const s of pending) {
            if (subCmd === "trust") {
              // Show the URL for *any* url transport. Keying this on `transport === "sse"`
              // meant a streamable-http server was confirmed as an empty command line —
              // asking someone to approve a thing by showing them a different thing.
              const line = s.config.url
                ? `${s.config.transport} ${s.config.url}`
                : `${s.config.command} ${(s.config.args || []).join(" ")}`.trim();
              console.log(`\n${colors.bold}You are agreeing to run:${colors.reset} ${colors.cyan}${line}${colors.reset}`);
              console.log(`${colors.gray}from ${path.relative(workspaceRoot, getProjectMcpConfigPaths(workspaceRoot)[0]) || "mcp.json"}, as a subprocess with a minimal environment (PATH/HOME/TMP only) plus whatever that file's "env" block sets explicitly.${colors.reset}`);
              const ok = await confirm({ message: "Trust and start this MCP server?", default: false }).catch(() => false);
              if (ok) {
                trustMcpServer(s.config, `trusted manually on ${new Date().toISOString()}`);
                // Connect immediately instead of telling the user to run the command twice:
                // the human has now seen and agreed to this exact line, and that is the only
                // gate in the way.
                const reconnected = await mcpManager.reconnect(s.config.id).catch(() => null);
                if (reconnected?.status === "connected") {
                  const total = mcpManager.registerToolsInto(registry);
                  console.log(
                    `${colors.brightGreen}✓ Trusted and connected${colors.reset} — ` +
                    `${reconnected.tools.length} tool(s) from ${reconnected.wire || s.config.transport}` +
                    `${reconnected.serverInfo?.name ? ` (${reconnected.serverInfo.name})` : ""}; registry now has ${total}.\n`
                  );
                } else {
                  console.log(
                    `${colors.yellow}✓ Trusted, but it did not come up:${colors.reset} ` +
                    `${(reconnected?.error || "connection failed").split("\n")[0]}\n`
                  );
                }
              } else {
                console.log(`${colors.yellow}⊘ Not trusted.${colors.reset}\n`);
              }
            } else {
              const removed = s.config.trustId ? revokeMcpServer(s.config.trustId) : false;
              console.log(
                removed
                  ? `\n${colors.brightGreen}✓ Trust revoked for "${s.config.id}".${colors.reset}\n`
                  : `\n${colors.gray}"${s.config.id}" was not in the trust store.${colors.reset}\n`
              );
            }
          }
          continue;
        }

        if (subCmd === "add" && query) {
          // This used to hand the model a to-do list that ended in "use write_file to
          // edit .inflynx/mcp.json" — which turns anything the model reads on the web
          // into a command it is allowed to run on this machine. The research may
          // still be delegated; the *write* is a code path behind a confirmation, so
          // untrusted content can propose but never install (backlog B6).
          console.log(`\n${colors.brightCyan}🔌 MCP server setup — Inflynx will write the config, not the model.${colors.reset}`);
          console.log(`${colors.gray}Searching the web for the official package is optional; it is untrusted input and can only influence what is *proposed*, never what is saved.${colors.reset}\n`);

          let suggested: { id: string; command: string; args?: string[]; env?: Record<string, string>; envPassthrough?: string[] } | null = null;
          const offerManual = async () => {
            const command = await input({ message: `command (e.g. npx)` });
            const argStr = await input({ message: `args (space-separated, may be empty)`, default: "" });
            const envNames = await input({ message: `env var names it needs (comma-separated, may be empty)`, default: "" });
            suggested = {
              id: query.trim().toLowerCase().replace(/\s+/g, "-"),
              command,
              args: argStr.trim() ? argStr.trim().split(/\s+/) : [],
              envPassthrough: envNames.trim()
                ? envNames.split(",").map((n) => n.trim()).filter(Boolean)
                : undefined,
            };
          };
          const auto = await select({
            message: `${colors.bold}How should Inflynx configure "${query}"?${colors.reset}`,
            choices: [
              { name: "Type the command myself (recommended — you know what you installed)", value: "manual" },
              { name: "Ask the model to research it first (untrusted web content)", value: "research" },
              { name: "Cancel", value: "cancel" },
            ],
          });

          if (auto === "cancel") {
            console.log(`\n${colors.yellow}⊘ Cancelled.${colors.reset}\n`);
            continue;
          }

          if (auto === "research") {
            console.log(`\n${colors.gray}Researching… the model is limited to read-only tools for this turn.${colors.reset}`);
            const previousMode = activeMode;
            activeMode = "ask";
            orchestrator.setMode("ask");
            orchestrator.setSystemPrompt(buildModeSystemPrompt("ask"));
            const research = await orchestrator.runTurn([
              `Research the MCP (Model Context Protocol) server for: "${query}".`,
              `Answer with ONLY a JSON object, no prose, no markdown fence:`,
              `{"id":"<short-slug>","command":"<executable>","args":["<arg>","..."],"envPassthrough":["<ENV NAME the server needs>"]}`,
              `Do not invent a package you are unsure about; if you cannot name one, return {"id":"${query}","command":""}.`,
            ].join("\n")).catch(() => null);
            orchestrator.setMode(previousMode);
            orchestrator.setSystemPrompt(buildModeSystemPrompt(previousMode));

            const jsonMatch = (research?.finalText || "").match(/\{[\s\S]*\}/);
            const proposal = jsonMatch ? safeParseJsonObject(jsonMatch[0]) : null;
            if (proposal && typeof proposal.command === "string" && proposal.command.trim()) {
              suggested = {
                id: String(proposal.id || query).toLowerCase().replace(/\s+/g, "-"),
                command: String(proposal.command).trim(),
                args: Array.isArray(proposal.args) ? proposal.args.map(String) : [],
                envPassthrough: Array.isArray(proposal.envPassthrough) ? proposal.envPassthrough.map(String) : undefined,
              };
            } else {
              console.log(`${colors.yellow}The model did not return a usable proposal.${colors.reset}`);
            }
          }

          if (!suggested) await offerManual();

          const cfg = suggested!;
          console.log(`\n${colors.bold}About to add MCP server:${colors.reset}`);
          console.log(`  ${colors.cyan}id${colors.reset}      ${cfg.id}`);
          console.log(`  ${colors.cyan}command${colors.reset}  ${cfg.command} ${(cfg.args || []).join(" ")}`);
          if (cfg.envPassthrough?.length) {
            console.log(`  ${colors.cyan}env${colors.reset}       will receive: ${cfg.envPassthrough.join(", ")}`);
          }
          console.log(`${colors.gray}Nothing else from your environment is passed to it.${colors.reset}`);

          const ok = await confirm({ message: "Save and start this server?", default: false }).catch(() => false);
          if (!ok) {
            console.log(`\n${colors.yellow}⊘ Not added. Re-run /mcp add ${query} any time.${colors.reset}\n`);
            continue;
          }

          try {
            const added = await mcpManager.addServer(
              { id: cfg.id, transport: "stdio", command: cfg.command, args: cfg.args, envPassthrough: cfg.envPassthrough },
              workspaceRoot
            );
            const registered = mcpManager.registerToolsInto(registry);
            console.log(
              `\n${colors.brightGreen}✓ Added "${cfg.id}" — ${added.tools.length} tool(s); registry now has ${registered}.${colors.reset}\n`
            );
          } catch (err: any) {
            console.log(`\n${colors.red}✗ Saved, but connecting failed: ${err?.message || err}${colors.reset}`);
            console.log(`${colors.gray}Fix the command and run /mcp again; the entry is in .inflynx/mcp.json.${colors.reset}\n`);
          }
          continue;
        } else if (subCmd === "add") {
          console.log(`\n${colors.gray}Usage: /mcp add <name>  |  /mcp trust <id>  |  /mcp untrust <id>${colors.reset}\n`);
          continue;
        } else {
          console.log(`\n${colors.bold}${colors.brightMagenta}🔌 Model Context Protocol (MCP) Connectors:${colors.reset}`);
          const servers = mcpManager.listServers();
          if (servers.length === 0) {
            console.log(`  ${colors.gray}No MCP servers configured in .inflynx/mcp.json${colors.reset}\n`);
          } else {
            for (const s of servers) {
              const statusColor =
                s.status === "connected" ? colors.brightGreen
                : s.status === "disabled" ? colors.yellow
                : s.status === "needs-trust" ? colors.brightCyan
                : colors.red;
              const origin = s.config.source === "user" ? "~/.inflynx" : "this repo";
              // The *negotiated* wire, not the configured one: a config that says
              // streamable-http and falls back to legacy SSE would otherwise be reported
              // as something it is not actually talking.
              const wire = (s.wire || s.config.transport).toUpperCase();
              // The whole command line, args included. Showing just `npx` here made a
              // server that actually runs `npx -y @modelcontextprotocol/server-memory`
              // look like something else in the one list people read to check config.
              const target = s.config.url
                || (s.config.command ? `${s.config.command} ${(s.config.args || []).join(" ")}`.trim() : "");
              const who = s.serverInfo?.name
                ? ` · ${s.serverInfo.name}${s.serverInfo.version ? ` ${s.serverInfo.version}` : ""}`
                : "";
              console.log(`  ${colors.cyan}• ${s.config.id}${colors.reset} [${statusColor}${s.status}${colors.reset}] — ${wire} ${target}${who} ${colors.gray}(${origin})${colors.reset}`);
              if (s.tools.length > 0) {
                console.log(`    ${colors.gray}Tools (${s.tools.length}): ${s.tools.map((t) => t.name).join(", ")}${colors.reset}`);
              }
              if (s.error) {
                // "Error: Connected, but the server advertised no tools" is not an error.
                // A healthy-but-empty server gets a neutral prefix so the list stays readable.
                const prefix = s.status === "needs-trust" ? "Waiting on you: "
                  : s.status === "connected" ? "Note: " : "Error: ";
                console.log(`    ${s.status === "connected" ? colors.yellow : colors.red}${prefix}${s.error}${colors.reset}`);
              }
            }
            const needingTrust = servers.filter((s) => s.status === "needs-trust");
            if (needingTrust.length > 0) {
              console.log(
                `\n  ${colors.brightCyan}${needingTrust.length} server(s) defined by this repository are not running.${colors.reset}\n` +
                `  ${colors.gray}Repo content cannot grant itself permission to execute. Review then run:${colors.reset}\n` +
                needingTrust.map((s) => `    ${colors.cyan}/mcp trust ${s.config.id}${colors.reset}`).join("\n") +
                "\n"
              );
            }
            const trustedEntries = listTrustedMcpServers();
            if (trustedEntries.length > 0) {
              console.log(
                `  ${colors.gray}Trust store: ${trustedEntries.length} entr(y/ies) in ~/.inflynx/mcp-trust.json ` +
                `(revoked with /mcp untrust <id>; an entry stops applying if the command it records changes).${colors.reset}\n`
              );
            }
            console.log();
          }
          console.log(`${colors.gray}Tip: '/mcp add <name>' configures a server — you approve the exact command before it is saved or run.${colors.reset}\n`);
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

      if (cmd === "models") {
        if (arg?.toLowerCase() === "refresh") {
          const providerId = parts[2] || activeProvider.id;
          const provider = getProvider(providerId);
          if (!provider) {
            console.log(`\n${colors.red}Model refresh supports known providers only.${colors.reset}\n`);
            continue;
          }
          try {
            const key = provider.id === activeProvider.id
              ? activeApiKey
              : getApiKeyForProvider(provider.id);
            const discovered = await refreshModelCatalog(provider.id, key);
            console.log(
              `\n${colors.brightGreen}✓ Refreshed ${discovered.length} explicitly tool-capable model(s) from ${provider.name}.${colors.reset}\n` +
              `${colors.gray}They are stored as unverified BYOK choices and were not added to curated defaults.${colors.reset}\n`
            );
          } catch (err: any) {
            console.log(`\n${colors.red}✗ Refresh failed: ${redactSecrets(err?.message || String(err))}${colors.reset}\n`);
          }
          continue;
        }
        console.log(`\n${colors.bold}${colors.brightCyan}Curated BYOK Models:${colors.reset}`);
        for (const provider of TOP_PROVIDERS) {
          const models = MODEL_CATALOG[provider.id];
          console.log(`\n  ${colors.bold}${provider.name}${colors.reset} (${provider.envKey})`);
          for (const model of models) {
            const tools = model.supportsTools ? "tools" : "no tools";
            const thinking = model.supportsThinking
              ? `thinking: ${model.supportedEfforts.join("/")}`
              : "no thinking";
            console.log(`    ${colors.yellow}${model.id}${colors.reset} — ${tools}, ${thinking}`);
          }
          console.log(`    ${colors.gray}Custom model ID: /credentials add (select ${provider.name})${colors.reset}`);
        }
        console.log(
          `\n${colors.gray}Defaults are BYOK recommendations. Inflynx never supplies or persists a platform API key. ` +
          `For a non-listed OpenAI-compatible endpoint, use /credentials add and choose Custom endpoint. ` +
          `Refresh official tool-capable listings with /models refresh [provider].${colors.reset}\n`
        );
        continue;
      }

      if (cmd === "credentials") {
        const action = arg?.toLowerCase() || "list";
        if (action === "list") {
          const profiles = listCredentialProfiles();
          console.log(`\n${colors.bold}${colors.brightCyan}OS-keychain Credential Profiles:${colors.reset}`);
          if (!profiles.length) {
            console.log(`  ${colors.gray}No saved profiles. Add one with /credentials add.${colors.reset}\n`);
          } else {
            for (const profile of profiles) {
              const active = profile.id === activeCredentialProfile?.id ? ` ${colors.brightMagenta}(ACTIVE)${colors.reset}` : "";
              const endpoint = profile.baseURL ? ` @ ${profile.baseURL}` : "";
              console.log(
                `  ${colors.cyan}${profile.id}${colors.reset} | ${profile.label} | ` +
                  `${profile.providerId}/${profile.defaultModel}${endpoint}${active}`
              );
            }
            console.log(`\n${colors.gray}Use /credentials use <id>, /credentials add, or /credentials remove <id>.${colors.reset}\n`);
          }
          continue;
        }

        if (action === "remove" && parts[2]) {
          const removed = deleteCredentialProfile(parts[2]);
          if (removed && activeCredentialProfile?.id === parts[2]) {
            activeCredentialProfile = undefined;
            activeApiKey = getApiKeyForProvider(activeProvider.id);
          }
          console.log(removed
            ? `\n${colors.brightGreen}✓ Credential profile removed.${colors.reset}\n`
            : `\n${colors.yellow}Credential profile not found.${colors.reset}\n`);
          continue;
        }

        if (action === "use" && parts[2]) {
          const profile = getCredentialProfile(parts[2]);
          if (!profile) {
            console.log(`\n${colors.red}Credential profile not found: ${parts[2]}${colors.reset}\n`);
            continue;
          }
          try {
            const apiKey = resolveCredentialSecret(profile);
            if (profile.providerId === "custom-openai-compatible") {
              await switchToCustomModel(profile, apiKey);
            } else {
              const provider = getProvider(profile.providerId);
              if (!provider) throw new Error(`Unknown provider "${profile.providerId}".`);
              await switchToKnownModel(provider, profile.defaultModel, apiKey, profile);
            }
            console.log(`\n${colors.brightGreen}✓ Selected credential profile "${profile.label}" in new session ${orchestrator.sessionId}.${colors.reset}\n`);
          } catch (err: any) {
            console.log(`\n${colors.red}✗ Unable to use credential profile: ${redactSecrets(err?.message || String(err))}${colors.reset}\n`);
          }
          continue;
        }

        if (action === "add") {
          try {
            const providerId = await select({
              message: "Credential provider:",
              choices: [
                ...TOP_PROVIDERS.map((provider) => ({ name: provider.name, value: provider.id })),
                { name: "Custom OpenAI-compatible endpoint", value: "custom-openai-compatible" },
              ],
            });
            const provider = getProvider(providerId);
            const label = await askUserPrompt(`${colors.yellow}Profile label:${colors.reset} `);
            let model: string;
            let baseURL: string | undefined;
            let allowLocalEndpoint = false;
            let customCapabilities: CredentialProfile["customCapabilities"];
            if (providerId === "custom-openai-compatible") {
              model = await askUserPrompt(`${colors.yellow}Custom model ID:${colors.reset} `);
              baseURL = await askUserPrompt(`${colors.yellow}Custom base URL (HTTPS; localhost requires opt-in):${colors.reset} `);
              if (/^https?:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(baseURL)) {
                allowLocalEndpoint = await confirm({ message: "Explicitly allow this local endpoint?", default: false });
              }
              const supportsTools = await confirm({
                message: "Does this endpoint explicitly support OpenAI-compatible tool calls?",
                default: false,
              });
              const supportsThinking = await confirm({
                message: "Does this endpoint explicitly support OpenAI-compatible reasoning effort?",
                default: false,
              });
              let supportedEfforts: ReasoningEffort[] = ["none"];
              if (supportsThinking) {
                const entered = await askUserPrompt(
                  `${colors.yellow}Supported efforts (comma-separated: ${REASONING_EFFORTS.join(", ")}):${colors.reset} `
                );
                const parsed = entered
                  .split(",")
                  .map((level) => level.trim())
                  .filter((level): level is ReasoningEffort => REASONING_EFFORTS.includes(level as ReasoningEffort));
                if (!parsed.length) throw new Error("Specify at least one valid supported effort.");
                supportedEfforts = Array.from(new Set<ReasoningEffort>(["none", ...parsed]));
              }
              customCapabilities = { supportsTools, supportedEfforts };
            } else {
              const useCustomModel = await confirm({ message: "Use a custom model ID instead of curated models?", default: false });
              model = useCustomModel
                ? await askUserPrompt(`${colors.yellow}Custom model ID:${colors.reset} `)
                : await selectModelDropdown(provider!.defaultModel, provider!);
            }
            const apiKey = await password({ message: "API key (stored only in OS keychain):", mask: "*" });
            const profile = createCredentialProfile({
              label,
              providerId: providerId as CredentialProfile["providerId"],
              defaultModel: model,
              baseURL,
              allowLocalEndpoint,
              customCapabilities,
              apiKey: apiKey.trim(),
            });
            if (profile.providerId === "custom-openai-compatible") {
              await switchToCustomModel(profile, apiKey.trim());
            } else {
              await switchToKnownModel(provider!, profile.defaultModel, apiKey.trim(), profile);
            }
            console.log(`\n${colors.brightGreen}✓ Profile saved in OS keychain and selected in new session ${orchestrator.sessionId}.${colors.reset}\n`);
          } catch (err: any) {
            console.log(`\n${colors.red}✗ Credential profile was not created: ${redactSecrets(err?.message || String(err))}${colors.reset}\n`);
          }
          continue;
        }

        console.log(`\n${colors.yellow}Usage: /credentials [list|add|use <id>|remove <id>]${colors.reset}\n`);
        continue;
      }

      if (cmd === "effort" || cmd === "thinking" || cmd === "reasoning") {
        try {
          const effort = (arg
            ? arg
            : await select({
                message: "Select model thinking / reasoning effort:",
                choices: REASONING_EFFORTS.map((level) => ({ name: level, value: level })),
              })) as ReasoningEffort;
          if (!REASONING_EFFORTS.includes(effort)) throw new Error(`Unknown effort "${effort}".`);
          await orchestrator.setReasoningEffort(effort);
          activeReasoningEffort = effort;
          console.log(`\n${colors.brightGreen}✓ Active thinking/reasoning effort set to: [${effort}]${colors.reset}\n`);
        } catch (err: any) {
          console.log(`\n${colors.red}✗ ${redactSecrets(err?.message || String(err))}${colors.reset}\n`);
        }
        continue;
      }

      if (cmd === "budget") {
        try {
          const level = (arg && (["low", "medium", "high", "max"] as AgentBudgetLevel[]).includes(arg as AgentBudgetLevel)
            ? arg
            : await select({
                message: "Select agent loop budget level (max turns, tool calls, and time limits):",
                choices: [
                  { name: `low     (Max 15 turns, 30 tool calls, 6 min wall clock) — quick single tasks`, value: "low" },
                  { name: `medium  (Max 45 turns, 90 tool calls, 25 min wall clock) — standard engineering tasks`, value: "medium" },
                  { name: `high    (Max 90 turns, 225 tool calls, 60 min wall clock) — deep architectural / multi-step tasks`, value: "high" },
                  { name: `max     (Max 150 turns, 350 tool calls, 120 min wall clock) — unrestricted enterprise endurance`, value: "max" },
                ],
              })) as AgentBudgetLevel;
          orchestrator.setBudgetLevel(level);
          activeBudgetLevel = level;
          const p = DEFAULT_EFFORT_PROFILES[level];
          console.log(
            `\n${colors.brightGreen}✓ Agent loop budget set to [${level}]:${colors.reset} ` +
            `Max ${p.maxModelTurns} model turns, ${p.maxToolCalls} tool calls, ${Math.round(p.maxWallClockMs / 60000)}m time limit.\n`
          );
        } catch { console.log(); }
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
            let profile: CredentialProfile | undefined;
            const availableProfiles = listCredentialProfiles().filter((candidate) => candidate.providerId === target!.id);
            if (availableProfiles.length) {
              const useSaved = await confirm({ message: "Use a saved OS-keychain credential profile?", default: true });
              if (useSaved) {
                const selectedId = await select({
                  message: "Credential profile:",
                  choices: availableProfiles.map((candidate) => ({
                    name: `${candidate.label} (${candidate.defaultModel})`,
                    value: candidate.id,
                  })),
                });
                profile = getCredentialProfile(selectedId);
                if (profile) key = resolveCredentialSecret(profile);
              }
            }
            if (!key) {
              console.log();
              const entered = await password({
                message: `${colors.yellow}Enter API Key for ${target.name} (stored in OS keychain):${colors.reset}`,
                mask: "*",
              });
              if (entered.trim()) {
                const profileLabel = await askUserPrompt(`${colors.yellow}Profile label:${colors.reset} `);
                profile = createCredentialProfile({
                  label: profileLabel || `${target.name} key`,
                  providerId: target.id,
                  defaultModel: target.defaultModel,
                  apiKey: entered.trim(),
                });
                key = entered.trim();
                console.log(`${colors.brightGreen}✓ Key saved in OS keychain.${colors.reset}`);
              }
            }
            const chosenModel = await selectModelDropdown(profile?.defaultModel || target.defaultModel, target);
            if (!key) {
              console.log(`\n${colors.yellow}⚠ ${target.envKey} is missing; provider was not changed.${colors.reset}\n`);
              continue;
            }
            await switchToKnownModel(target, chosenModel, key, profile);
            console.log(`\n${colors.brightGreen}✓ Provider:${colors.reset} ${target.name}  ${colors.brightCyan}Model:${colors.reset} ${activeModel}`);
            console.log(`${colors.gray}Credential source: ${profile ? "OS keychain profile" : "environment variable"}${colors.reset}`);
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
              if (match) {
                const key = p.id === activeProvider.id
                  ? activeApiKey
                  : getApiKeyForProvider(p.id);
                if (!key) throw new Error(`No API key available for ${p.name}. Use /credentials add first.`);
                await switchToKnownModel(
                  p,
                  match,
                  key,
                  p.id === activeProvider.id ? activeCredentialProfile : undefined
                );
                break;
              }
            }
            console.log(`\n${colors.brightGreen}✓ Model:${colors.reset} ${activeModel} (${activeProvider.name})\n`);
          } else {
            const res = await selectAllModelsDropdown(activeModel, activeProvider.id);
            if (res) {
              const key = res.provider.id === activeProvider.id
                ? activeApiKey
                : getApiKeyForProvider(res.provider.id);
              if (!key) throw new Error(`No API key available for ${res.provider.name}. Use /credentials add first.`);
              await switchToKnownModel(
                res.provider,
                res.model,
                key,
                res.provider.id === activeProvider.id ? activeCredentialProfile : undefined
              );
              console.log(`\n${colors.brightGreen}✓ Provider:${colors.reset} ${res.provider.name}  ${colors.brightCyan}Model:${colors.reset} ${activeModel}\n`);
            }
          }
        } catch { console.log(); }
        continue;
      }

      if (cmd === "clear") {
        // Starts a brand-new persisted session rather than just wiping the
        // local view — with real DB persistence, silently continuing to write
        // into the OLD session row while showing an empty local history would
        // make that session's transcript inconsistent on a later /resume.
        orchestrator = await AgentOrchestrator.start(
          {
            workspaceRoot,
            providerId: activeProvider.id,
            model: activeModel,
            apiKey: activeApiKey || "",
            credentialProfileId: activeCredentialProfile?.id,
            baseURL: activeCredentialProfile?.baseURL,
            modelAdapter: activeProvider.adapter,
            reasoningEffort: "none",
            allowUnauthenticated: activeProvider.id === "custom-openai-compatible" && !activeApiKey,
            allowLocalEndpoint: activeCredentialProfile?.allowLocalEndpoint,
            customCapabilities: activeProvider.id === "custom-openai-compatible"
              ? activeCredentialProfile?.customCapabilities || { supportsTools: false, supportedEfforts: ["none"] }
              : undefined,
            activeMode,
            systemPrompt: buildModeSystemPrompt(activeMode),
          },
          registry,
          eventBus,
          approvalHandler,
          "medium",
          sessionStore
        );
        console.clear();
        displayWelcomeBanner(activeModel, activeProvider.id, workspaceRoot);
        continue;
      }

      if (cmd === "exit" || cmd === "quit") {
        const running = orchestrator.runningShellCount();
        if (running > 0) {
          // Say which ones, so the choice to leave is informed rather than a coin flip.
          console.log(`\n${colors.yellow}⚠ ${running} background shell(s) still running:${colors.reset}`);
          for (const shell of orchestrator.runningShells()) {
            console.log(`  ${colors.cyan}${shell.id}${colors.reset} $ ${shell.command}`);
          }
          const sure = await confirm({
            message: `Stopping them all and exit? Choosing no returns to the prompt.`,
            default: true,
          }).catch(() => false);
          if (!sure) {
            console.log(`${colors.gray}Still running. Use shell_stop <id>, or /exit again to confirm.${colors.reset}\n`);
            continue;
          }
        }
        exitInflynx(0, "Goodbye!");
      }

      // If command was /mcp add, /skills add, /plan <task>, /execute-plan, or /debug <task>, break out and let LLM process!
      const passthroughToLLM = (
        (cmd === "mcp" || cmd === "skills") && parts[1]?.toLowerCase() === "add"
      ) || (
        cmd === "plan" && parts.length > 1 && parts[1]?.toLowerCase() !== "history" && parts[1]?.toLowerCase() !== "restore"
      ) || (
        cmd === "execute-plan"
      ) || (
        cmd === "debug" && parts.length > 1 && parts[1]?.toLowerCase() !== "report" && parts[1]?.toLowerCase() !== "history"
      );

      if (!passthroughToLLM) {
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
    const rawMentions = parseAtMentions(inputStr, workspaceIndex);

    // Deduplicate mentions by filePath
    const uniqueMentionsMap = new Map<string, typeof rawMentions[0]>();
    for (const m of rawMentions) {
      if (!uniqueMentionsMap.has(m.filePath)) {
        uniqueMentionsMap.set(m.filePath, m);
      }
    }
    const mentions = Array.from(uniqueMentionsMap.values());

    let attachedContext = "";
    if (mentions.length > 0) {
      console.log(`${colors.brightMagenta}📎 Mentioned Files:${colors.reset} ${mentions.map((m) => m.filePath).join(", ")}`);
      attachedContext = resolveAtMentionContext(mentions);
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
      attachedContext += (attachedContext ? "\n\n" : "") + `=== Relevant Active Skills ===\n${skillBlocks}`;
    }

    // ─── Agentic Turn ────────────────────────────────────────────────────────────
    // AgentOrchestrator.runTurn() now owns the entire loop: streaming, mode-based
    // tool filtering, approval requests (via `approvalHandler`), guarded execution
    // (via ToolExecutionGateway — path/command policy enforced centrally), budget
    // tracking, and persistence of every user/assistant/tool message + token
    // telemetry to SessionStore. Everything printed during the turn is driven by
    // the `eventBus` listeners registered once at startup, above.
    turnInFlight = true;
    interruptRequested = false;
    let turnResult: Awaited<ReturnType<AgentOrchestrator["runTurn"]>> | undefined;
    try {
      turnResult = await orchestrator.runTurn(inputStr, attachedContext || undefined);
    } catch (err: any) {
      console.error(`\n${colors.red}❌ Unexpected orchestrator error:${colors.reset} ${err?.message || String(err)}\n`);
    } finally {
      turnInFlight = false;
    }

    // The verification gate's own words, printed where the user always looks: the end of
    // a turn. `verification.started/finished` also stream on the event bus, but a control
    // that exists only as an event is a control nobody sees — the same reason `/security`
    // and `/tokens` report live state instead of reciting policy (backlog Phase 31).
    const gate = turnResult?.verification;
    if (gate) {
      const tone =
        gate.outcome === "passed" ? colors.brightGreen :
        gate.outcome === "failed" ? colors.red : colors.yellow;
      console.log(
        `${tone}🔒 verification: ${gate.outcome}${colors.reset}` +
        `${colors.gray}  ·  ${gate.packageManager ?? "?"} ${gate.depth} depth  ·  `
        + `${gate.checksRun} check(s)  ·  ${gate.sourceFilesChanged.length} file(s) changed`
        + `${gate.repairAttempts ? `  ·  ${gate.repairAttempts} repair attempt(s)` : ""}${colors.reset}`
      );
      if (gate.failedChecks.length > 0) {
        console.log(`   ${colors.red}failing gates:${colors.reset} ${gate.failedChecks.join(", ")}`);
      }
      if (gate.outcome !== "passed" && gate.summaryMessage) {
        console.log(`   ${colors.gray}${gate.summaryMessage}${colors.reset}`);
      }
    }
    console.log();
  }
}

main().catch(console.error);
