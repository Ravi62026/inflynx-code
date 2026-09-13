/**
 * @inflynx/tool-runtime
 * Dynamic Tool Registry, Core Tools, & Dependency DAG Scheduler.
 */

import fs from "fs";
import path from "path";
import { validatePublicUrl, CanonicalPathGuard, CommandPolicy } from "@inflynx/policy-engine";
import { applySurgicalPatch, computeUnifiedDiff, EditTransactionManager } from "@inflynx/patch-engine";

export { ToolExecutionGateway, type GatewayExecutionOptions } from "./ToolExecutionGateway.js";

// ─── Workspace Helper ─────────────────────────────────────────────────────────

function getWorkspaceRoot(): string {
  return process.env.INFLYNX_WORKSPACE_ROOT || process.cwd();
}

function resolveWorkspacePath(targetPath: string): string {
  const guard = new CanonicalPathGuard(getWorkspaceRoot());
  return guard.validateAndResolve(targetPath);
}

// ─── JSON Tool Argument Parser & Repair Helper ────────────────────────────────

export function safeParseJsonArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.raw === "string" && Object.keys(obj).length === 1) {
      return safeParseJsonArgs(obj.raw);
    }
    return obj;
  }
  if (typeof raw !== "string") return {};

  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      const sanitized = trimmed.replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, (match) => {
        return match
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r")
          .replace(/\t/g, "\\t");
      });
      return JSON.parse(sanitized);
    } catch {
      try {
        const pathMatch = trimmed.match(/"path"\s*:\s*"([^"]+)"/);
        const contentMatch = trimmed.match(/"content"\s*:\s*"([\s\S]*)"/);
        if (pathMatch) {
          return {
            path: pathMatch[1],
            content: contentMatch ? contentMatch[1] : "",
          };
        }
      } catch { /* ignore */ }
      return { raw: trimmed };
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  dependencies?: string[];
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; default?: unknown }>;
    required: string[];
  };
  isMutating?: boolean;
  permissionLevel: "readonly" | "readwrite" | "shell";
  origin?: "core" | "mcp" | "plugin";
  serverName?: string;
  execute: (args: TArgs, signal?: AbortSignal) => Promise<string>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  output: string;
  isError?: boolean;
  durationMs: number;
}

// ─── Core Tool Implementations ────────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script\b[^<]*>([\s\S]*?)<\/script>/gi, "")
    .replace(/<style\b[^<]*>([\s\S]*?)<\/style>/gi, "")
    .replace(/<head\b[^<]*>([\s\S]*?)<\/head>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

export const CORE_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path. Optionally specify start and end line numbers.",
    permissionLevel: "readonly",
    isMutating: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path to file" },
        start_line: { type: "number", description: "Optional start line (1-indexed)", default: 1 },
        end_line: { type: "number", description: "Optional end line (inclusive)", default: 0 },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const { path: filePath, start_line, end_line } = args as {
        path: string; start_line?: number; end_line?: number;
      };

      const absPath = resolveWorkspacePath(filePath);
      if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: ${absPath}`);
      }

      const stat = fs.statSync(absPath);
      if (stat.size > 1_000_000) {
        throw new Error(`File too large (${(stat.size / 1024).toFixed(0)} KB). Use search_files to locate specific sections.`);
      }

      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");
      const start = (start_line ?? 1) - 1;
      const end = end_line && end_line > 0 ? end_line : lines.length;
      const sliced = lines.slice(start, end);

      return sliced
        .map((l, i) => `${String(start + i + 1).padStart(4)} │ ${l}`)
        .join("\n");
    },
  },

  {
    name: "patch_file",
    description: "Surgically replace a specific function, class, or code snippet in a file without modifying untouched code.",
    permissionLevel: "readwrite",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path to file" },
        target_code: { type: "string", description: "Exact code block or function lines to replace" },
        replacement_code: { type: "string", description: "New replacement code block or function lines" },
      },
      required: ["path", "target_code", "replacement_code"],
    },
    execute: async (args) => {
      const { path: filePath, target_code, replacement_code } = args as {
        path: string; target_code: string; replacement_code: string;
      };

      const txManager = new EditTransactionManager();
      const patch = txManager.stagePatch(filePath, target_code, replacement_code);
      txManager.commit();

      return `✓ Surgically patched: ${filePath}\nDiff:\n${patch.diff}`;
    },
  },

  {
    name: "write_file",
    description: "Write or overwrite a file with provided content. Creates parent directories if needed.",
    permissionLevel: "readwrite",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path to file" },
        content: { type: "string", description: "Full content to write to file" },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const { path: filePath, content } = args as { path: string; content: string };
      const txManager = new EditTransactionManager();
      txManager.stageFileWrite(filePath, content);
      txManager.commit();

      const lines = content.split("\n").length;
      return `✓ Written: ${filePath} (${lines} lines)`;
    },
  },

  {
    name: "list_directory",
    description: "List directory contents recursively up to a given depth. Respects .gitignore patterns.",
    permissionLevel: "readonly",
    isMutating: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list", default: "." },
        depth: { type: "number", description: "Maximum directory depth to recurse", default: 3 },
      },
      required: [],
    },
    execute: async (args) => {
      const { path: dirPath = ".", depth = 3 } = args as { path?: string; depth?: number };
      const absPath = resolveWorkspacePath(dirPath);

      const IGNORED = new Set(["node_modules", ".git", "dist", ".cache", ".next", "coverage", ".turbo"]);

      const lines: string[] = [];
      function walk(dir: string, indent: string, currentDepth: number) {
        if (currentDepth > depth) return;
        let entries: string[];
        try {
          entries = fs.readdirSync(dir).sort();
        } catch {
          return;
        }

        for (const entry of entries) {
          if (IGNORED.has(entry) || entry.startsWith(".")) continue;
          const fullPath = path.join(dir, entry);
          const stat = fs.lstatSync(fullPath);
          if (stat.isSymbolicLink()) {
            lines.push(`${indent}🔗 ${entry} (symlink skipped)`);
            continue;
          }
          if (stat.isDirectory()) {
            lines.push(`${indent}📁 ${entry}/`);
            walk(fullPath, indent + "  ", currentDepth + 1);
          } else {
            const kb = (stat.size / 1024).toFixed(1);
            lines.push(`${indent}📄 ${entry} (${kb}KB)`);
          }
        }
      }

      walk(absPath, "", 1);
      return lines.join("\n") || "(empty directory)";
    },
  },

  {
    name: "search_files",
    description: "Search for a text pattern or regex in workspace files. Excludes node_modules, .git, and build artifacts.",
    permissionLevel: "readonly",
    isMutating: false,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (string or regex)" },
        path: { type: "string", description: "Directory or file to search in", default: "." },
        file_glob: { type: "string", description: "File glob filter (e.g. '*.ts')", default: "" },
        case_insensitive: { type: "boolean", description: "Case insensitive search", default: false },
      },
      required: ["pattern"],
    },
    execute: async (args, signal) => {
      const {
        pattern,
        path: searchPath = ".",
        file_glob = "",
        case_insensitive = false,
      } = args as { pattern: string; path?: string; file_glob?: string; case_insensitive?: boolean };

      const absPath = resolveWorkspacePath(searchPath);

      // Safe argument array execution for rg (ripgrep)
      const rgArgs: string[] = [
        "--line-number",
        "--no-heading",
        "--max-count=50",
        "--glob=!node_modules/**",
        "--glob=!.git/**",
        "--glob=!dist/**",
      ];
      if (case_insensitive) rgArgs.push("-i");
      if (file_glob) rgArgs.push("--glob", file_glob);
      rgArgs.push("--", pattern, absPath);

      // Safe argument array execution for grep fallback
      const grepArgs: string[] = [
        "-rn",
        "--max-count=50",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
      ];
      if (case_insensitive) grepArgs.push("-i");
      if (file_glob) grepArgs.push(`--include=${file_glob}`);
      grepArgs.push("--", pattern, absPath);

      try {
        const out = await CommandPolicy.execProcessDirect("rg", rgArgs, absPath, 10_000, signal);
        return out.trim() || `No matches found for: ${pattern}`;
      } catch {
        try {
          const out = await CommandPolicy.execProcessDirect("grep", grepArgs, absPath, 10_000, signal);
          return out.trim() || `No matches found for: ${pattern}`;
        } catch {
          return `No matches found for: ${pattern}`;
        }
      }
    },
  },

  {
    name: "web_search",
    description: "Search Google/DuckDuckGo live on the internet for documentation, packages, news, or error solutions.",
    permissionLevel: "readonly",
    isMutating: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query keywords" },
        max_results: { type: "number", description: "Max results to return (1-10)", default: 5 },
      },
      required: ["query"],
    },
    execute: async (args, signal) => {
      const { query, max_results = 5 } = args as { query: string; max_results?: number };
      const results: Array<{ title: string; link: string; snippet: string }> = [];

      // Strategy 1: Serper API if available
      const serperKey = process.env.SERPER_API_KEY;
      if (serperKey) {
        try {
          const res = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, num: max_results }),
          });
          if (res.ok) {
            const data: any = await res.json();
            if (Array.isArray(data.organic)) {
              for (const item of data.organic.slice(0, max_results)) {
                results.push({ title: item.title, link: item.link, snippet: item.snippet });
              }
            }
          }
        } catch { /* fallback */ }
      }

      // Strategy 2: Universal HTML scraping via curl
      if (results.length === 0) {
        try {
          const encoded = encodeURIComponent(query);
          const html = await CommandPolicy.execProcessDirect(
            "curl",
            [
              "-sL",
              "-m", "8",
              `https://html.duckduckgo.com/html/?q=${encoded}`,
              "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            ],
            process.cwd(),
            10_000,
            signal
          );

          const linkRegex = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          let match: RegExpExecArray | null;

          while ((match = linkRegex.exec(html)) !== null && results.length < max_results) {
            let rawUrl = match[1].trim();
            if (rawUrl.includes("uddg=")) {
              const matchUddg = rawUrl.match(/uddg=([^&]+)/);
              if (matchUddg) rawUrl = decodeURIComponent(matchUddg[1]);
            }
            if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;

            const title = stripHtmlTags(match[2]);
            const isExternalUrl = rawUrl.startsWith("http") &&
              !rawUrl.includes("duckduckgo.com") &&
              !rawUrl.includes("google.com") &&
              !rawUrl.includes("bing.com");

            if (title && title.length > 5 && isExternalUrl) {
              if (!results.some((r) => r.link === rawUrl)) {
                results.push({
                  title,
                  link: rawUrl,
                  snippet: title,
                });
              }
            }
          }
        } catch { /* fallback */ }
      }

      // Strategy 3: DuckDuckGo Instant Answer API
      if (results.length === 0) {
        try {
          const apiRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
          if (apiRes.ok) {
            const data: any = await apiRes.json();
            if (data.AbstractText && data.AbstractURL) {
              results.push({ title: data.Heading || query, link: data.AbstractURL, snippet: data.AbstractText });
            }
            if (Array.isArray(data.RelatedTopics)) {
              for (const topic of data.RelatedTopics) {
                if (results.length >= max_results) break;
                if (topic.Text && topic.FirstURL) {
                  results.push({ title: topic.Text.slice(0, 80) + "...", link: topic.FirstURL, snippet: topic.Text });
                }
              }
            }
          }
        } catch { /* fallback */ }
      }

      if (results.length === 0) {
        return `No live web search results found for query: "${query}". Try refining search terms.`;
      }

      return results
        .slice(0, max_results)
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.link}\n   Snippet: ${r.snippet}`)
        .join("\n\n");
    },
  },

  {
    name: "fetch_url",
    description: "Fetch web page content from a public URL and convert HTML to clean readable text.",
    permissionLevel: "readonly",
    isMutating: false,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public URL to fetch (http or https)" },
      },
      required: ["url"],
    },
    execute: async (args) => {
      const { url } = args as { url: string };
      try {
        const publicUrl = await validatePublicUrl(url);
        const response = await fetch(publicUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          },
          redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
          throw new Error("Redirects are disabled by SSRF protection; validate the redirect target explicitly.");
        }
        if (!response.ok) {
          throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        const text = stripHtmlTags(html);
        const truncated = text.length > 12_000 ? text.slice(0, 12_000) + "\n\n... (truncated for context length)" : text;

        return `Content from ${publicUrl.toString()}:\n\n${truncated}`;
      } catch (err: any) {
        return `Failed to fetch URL ${url}: ${err?.message || String(err)}`;
      }
    },
  },

  {
    name: "execute_shell",
    description: "Execute a shell command in the workspace. Returns stdout and stderr. 30 second timeout.",
    permissionLevel: "shell",
    isMutating: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Working directory for the command", default: "." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds", default: 30000 },
      },
      required: ["command"],
    },
    execute: async (args, signal) => {
      const {
        command,
        cwd: cmdCwd = ".",
        timeout_ms = 30_000,
      } = args as { command: string; cwd?: string; timeout_ms?: number };

      CommandPolicy.validateShellCommand(command);
      const absCwd = resolveWorkspacePath(cmdCwd);
      return await CommandPolicy.execShellTimed(command, absCwd, timeout_ms, signal);
    },
  },
];

// ─── Registry Class ────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = CORE_TOOLS) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  listByOrigin(origin: "core" | "mcp" | "plugin"): ToolDefinition[] {
    return this.list().filter((t) => (t.origin || "core") === origin);
  }

  /** Returns JSON schema array formatted for OpenAI/DeepSeek tool_choice */
  toOpenAIFormat(): object[] {
    return this.list().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /** Returns XML tool list for Anthropic system prompt injection */
  toAnthropicSystemPromptBlock(): string {
    return this.list()
      .map((t) => {
        const props = Object.entries(t.parameters.properties)
          .map(([k, v]) => `  - ${k} (${v.type}${t.parameters.required.includes(k) ? ", required" : ""}): ${v.description}`)
          .join("\n");
        return `<tool name="${t.name}">\n${t.description}\nParameters:\n${props}\n</tool>`;
      })
      .join("\n\n");
  }
}

export async function executeTool(
  registry: ToolRegistry,
  call: ToolCall,
  signal?: AbortSignal
): Promise<ToolResult> {
  const start = Date.now();
  const tool = registry.get(call.name);

  if (!tool) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: `Error: Unknown tool "${call.name}"`,
      isError: true,
      durationMs: Date.now() - start,
    };
  }

  const parsedArgs = safeParseJsonArgs(call.args);

  try {
    const output = await tool.execute(parsedArgs, signal);
    return {
      toolCallId: call.id,
      toolName: call.name,
      output,
      isError: false,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: `Error: ${err?.message || String(err)}`,
      isError: true,
      durationMs: Date.now() - start,
    };
  }
}
