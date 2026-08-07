/**
 * @inflynx/workspace-runtime
 * Incremental FS Watcher, Workspace Indexer, Semantic Code Symbol Graph, & Sandboxed PTY Execution.
 */

import fs from "fs";
import path from "path";

// ─── Existing Types ───────────────────────────────────────────────────────────

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "variable" | "type" | "enum";
  filePath: string;
  line: number;
  column: number;
  exported: boolean;
}

export interface SymbolGraph {
  symbols: Map<string, CodeSymbol>;
  imports: Map<string, string[]>;
  references: Map<string, string[]>;
}

export interface FsChangeEvent {
  type: "add" | "change" | "unlink";
  filePath: string;
  timestamp: number;
}

// ─── Workspace File Index ─────────────────────────────────────────────────────

export interface WorkspaceFile {
  relativePath: string;
  absolutePath: string;
  extension: string;
  language: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface WorkspaceIndex {
  rootDir: string;
  files: WorkspaceFile[];
  indexedAt: number;
  totalFiles: number;
}

// Language detection by extension
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".jsx": "javascriptreact",
  ".py": "python", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".java": "java", ".cs": "csharp",
  ".cpp": "cpp", ".c": "c", ".h": "c",
  ".html": "html", ".css": "css", ".scss": "scss",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".md": "markdown", ".mdx": "mdx",
  ".sh": "bash", ".zsh": "bash", ".bash": "bash",
  ".sql": "sql", ".graphql": "graphql", ".prisma": "prisma",
  ".env": "dotenv", ".gitignore": "ignore",
};

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".cache", ".next",
  "coverage", ".turbo", ".pnpm", "__pycache__", ".pytest_cache",
  ".venv", "venv", "target", ".cargo", ".gradle",
]);

const IGNORED_EXTENSIONS = new Set([
  ".lock", ".log", ".map", ".min.js", ".min.css",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg",
  ".ttf", ".woff", ".woff2", ".eot", ".mp4", ".mp3",
  ".zip", ".tar", ".gz", ".exe", ".bin",
]);

function loadGitignorePatterns(dir: string): Set<string> {
  const patterns = new Set<string>();
  const gitignorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return patterns;
  try {
    const lines = fs.readFileSync(gitignorePath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        patterns.add(trimmed.replace(/\/$/, "").replace(/^\//, ""));
      }
    }
  } catch { /* ignore */ }
  return patterns;
}

function isIgnoredByGitignore(name: string, gitignorePatterns: Set<string>): boolean {
  for (const pattern of gitignorePatterns) {
    if (name === pattern) return true;
    if (pattern.includes("*") && name.endsWith(pattern.replace("*", ""))) return true;
  }
  return false;
}

export function buildWorkspaceIndex(rootDir: string, maxDepth = 8): WorkspaceIndex {
  const files: WorkspaceFile[] = [];
  const gitignorePatterns = loadGitignorePatterns(rootDir);

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }

    for (const entry of entries) {
      if (entry.startsWith(".") && !entry.endsWith(".env")) continue;
      if (IGNORED_DIRS.has(entry)) continue;
      if (isIgnoredByGitignore(entry, gitignorePatterns)) continue;

      const absPath = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(absPath); } catch { continue; }

      if (stat.isDirectory()) {
        walk(absPath, depth + 1);
      } else {
        const ext = path.extname(entry).toLowerCase();
        if (IGNORED_EXTENSIONS.has(ext)) continue;
        if (stat.size > 500_000) continue; // skip >500KB files

        files.push({
          relativePath: path.relative(rootDir, absPath),
          absolutePath: absPath,
          extension: ext,
          language: EXTENSION_LANGUAGE_MAP[ext] || "text",
          sizeBytes: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      }
    }
  }

  walk(rootDir, 0);

  return {
    rootDir,
    files,
    indexedAt: Date.now(),
    totalFiles: files.length,
  };
}

// ─── Context Relevance Ranker ─────────────────────────────────────────────────

export interface RankedFile {
  file: WorkspaceFile;
  score: number;
  matchReason: string;
}

/**
 * Rank workspace files by relevance to the current user query.
 * Uses a fast BM25-like term frequency scoring combined with recency and path proximity.
 */
export function rankFilesByRelevance(
  index: WorkspaceIndex,
  query: string,
  activeFile?: string,
  topK = 8
): RankedFile[] {
  const queryTerms = query
    .toLowerCase()
    .split(/[\s/.,;:'"!?(){}[\]]+/)
    .filter((t) => t.length > 2);

  const now = Date.now();
  const ONE_HOUR = 3600_000;
  const ONE_DAY = 86_400_000;

  const scored: RankedFile[] = [];

  for (const file of index.files) {
    let score = 0;
    const reasons: string[] = [];
    const nameLower = file.relativePath.toLowerCase();

    // 1) Query term match in file path
    let termHits = 0;
    for (const term of queryTerms) {
      if (nameLower.includes(term)) termHits++;
    }
    if (termHits > 0) {
      score += termHits * 3;
      reasons.push(`path match (${termHits} terms)`);
    }

    // 2) Recency boost
    const ageMins = (now - file.modifiedAt) / 60_000;
    if (ageMins < 60) { score += 4; reasons.push("modified <1h ago"); }
    else if (ageMins < 1440) { score += 2; reasons.push("modified today"); }
    else if (ageMins < 10080) { score += 1; reasons.push("modified this week"); }

    // 3) Proximity to active file
    if (activeFile) {
      const activeDir = path.dirname(activeFile);
      const fileDir = path.dirname(file.relativePath);
      if (fileDir === activeDir) { score += 5; reasons.push("same directory"); }
      else if (fileDir.startsWith(activeDir) || activeDir.startsWith(fileDir)) {
        score += 2; reasons.push("adjacent directory");
      }
    }

    // 4) Language/extension bonus for code files
    if (["typescript", "javascript", "python", "rust", "go"].includes(file.language)) {
      score += 1;
    }

    // 5) Small files get slight boost (more focused)
    if (file.sizeBytes < 5000) score += 0.5;

    if (score > 0) {
      scored.push({ file, score, matchReason: reasons.join(", ") });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── @ Mention Parser ─────────────────────────────────────────────────────────

export interface AtMention {
  raw: string;         // e.g. "@src/utils.ts"
  filePath: string;    // resolved relative path
  absolutePath: string;
}

/**
 * Extract @filepath mentions from a user message.
 * Resolves them against the workspace index.
 */
export function parseAtMentions(message: string, index: WorkspaceIndex): AtMention[] {
  const mentionPattern = /@([\w./\-_]+\.[a-zA-Z]{1,6})/g;
  const mentions: AtMention[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(message)) !== null) {
    const raw = match[0];
    const mentionedPath = match[1];

    // Try exact match first
    const exact = index.files.find(
      (f) => f.relativePath === mentionedPath || f.relativePath.endsWith(mentionedPath)
    );

    if (exact) {
      mentions.push({ raw, filePath: exact.relativePath, absolutePath: exact.absolutePath });
      continue;
    }

    // Fuzzy match by filename
    const filename = path.basename(mentionedPath);
    const fuzzy = index.files.find((f) => path.basename(f.relativePath) === filename);
    if (fuzzy) {
      mentions.push({ raw, filePath: fuzzy.relativePath, absolutePath: fuzzy.absolutePath });
    }
  }

  return mentions;
}

/**
 * Read files referenced by @ mentions and return formatted context blocks.
 */
export function resolveAtMentionContext(mentions: AtMention[]): string {
  const blocks: string[] = [];

  for (const mention of mentions) {
    if (!fs.existsSync(mention.absolutePath)) {
      blocks.push(`<file path="${mention.filePath}">\n(File not found)\n</file>`);
      continue;
    }

    try {
      const content = fs.readFileSync(mention.absolutePath, "utf-8");
      const lines = content.split("\n");
      const numbered = lines
        .slice(0, 300) // max 300 lines for @mentions
        .map((l, i) => `${String(i + 1).padStart(4)} │ ${l}`)
        .join("\n");

      blocks.push(
        `<file path="${mention.filePath}" lines="${Math.min(lines.length, 300)}">\n${numbered}\n</file>`
      );
    } catch {
      blocks.push(`<file path="${mention.filePath}">\n(Error reading file)\n</file>`);
    }
  }

  return blocks.join("\n\n");
}

// ─── Codebase Mind Map & Dependency Graph Generator ───────────────────────────

export interface DependencyNode {
  id: string;
  label: string;
  type: "app" | "package" | "config";
  fileCount: number;
  path: string;
  dependencies: string[];
}

export interface WorkspaceGraphResult {
  nodes: DependencyNode[];
  mermaidMarkdown: string;
  svgContent: string;
  htmlContent: string;
  imageUrl: string;
}

/**
 * Scans workspace package dependencies and source imports to build a complete
 * Mermaid DAG diagram, SVG/PNG image render, and interactive D3.js HTML knowledge map.
 */
export function buildDependencyGraph(workspaceRoot: string): WorkspaceGraphResult {
  const nodes: DependencyNode[] = [];
  const edgeSet = new Set<string>();

  // 1. Discover all packages in apps/ and packages/
  const scanDirs = ["apps", "packages"];
  for (const scanDir of scanDirs) {
    const fullScanDir = path.join(workspaceRoot, scanDir);
    if (!fs.existsSync(fullScanDir)) continue;

    const subDirs = fs.readdirSync(fullScanDir);
    for (const subDir of subDirs) {
      const pkgPath = path.join(fullScanDir, subDir);
      const pkgJsonPath = path.join(pkgPath, "package.json");
      if (!fs.existsSync(pkgJsonPath)) continue;

      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
        const name = pkgJson.name || subDir;
        const deps = {
          ...pkgJson.dependencies,
          ...pkgJson.devDependencies,
        };

        // Count source files
        let fileCount = 0;
        const srcDir = path.join(pkgPath, "src");
        if (fs.existsSync(srcDir)) {
          const countFiles = (dir: string) => {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
              const full = path.join(dir, entry);
              if (fs.statSync(full).isDirectory()) countFiles(full);
              else fileCount++;
            }
          };
          countFiles(srcDir);
        }

        const internalDeps: string[] = [];
        for (const depName of Object.keys(deps)) {
          if (depName.startsWith("@inflynx/") || depName.includes("inflynx")) {
            const cleanDepName = depName.replace("@inflynx/", "");
            internalDeps.push(cleanDepName);
            edgeSet.add(`${subDir} --> ${cleanDepName}`);
          }
        }

        nodes.push({
          id: subDir,
          label: name,
          type: scanDir === "apps" ? "app" : "package",
          fileCount,
          path: `${scanDir}/${subDir}`,
          dependencies: internalDeps,
        });
      } catch { /* ignore invalid json */ }
    }
  }

  // 2. Generate Mermaid Markdown
  const mermaidLines: string[] = [
    "graph TD",
    "    %% Inflynx Codebase Architecture & Knowledge Graph",
    "    classDef app fill:#00e5ff,stroke:#0088cc,stroke-width:2px,color:#000;",
    "    classDef pkg fill:#7c4dff,stroke:#536def,stroke-width:2px,color:#fff;",
    "    classDef core fill:#ff0055,stroke:#c2185b,stroke-width:2px,color:#fff;",
  ];

  for (const node of nodes) {
    const styleClass = node.id === "agent-core" ? "core" : node.type === "app" ? "app" : "pkg";
    const icon = node.type === "app" ? "🌐" : "📦";
    mermaidLines.push(`    ${node.id.replace(/-/g, "_")}["${icon} ${node.label} (${node.fileCount} files)"]:::${styleClass}`);
  }

  mermaidLines.push("");
  for (const edge of Array.from(edgeSet)) {
    const [from, to] = edge.split(" --> ");
    mermaidLines.push(`    ${from.replace(/-/g, "_")} --> ${to.replace(/-/g, "_")}`);
  }

  const mermaidMarkdown = [
    `# 🌐 Codebase Mind Map & Dependency Knowledge Graph`,
    `> Generated: ${new Date().toISOString()}`,
    `> Total Components: ${nodes.length} (${nodes.filter(n => n.type === "app").length} Apps, ${nodes.filter(n => n.type === "package").length} Packages)`,
    ``,
    `\`\`\`mermaid`,
    ...mermaidLines,
    `\`\`\``,
    ``,
    `## 📦 Component Responsibilities & Dependencies`,
    `| Component | Type | Files | Dependencies |`,
    `|-----------|------|-------|--------------|`,
    ...nodes.map(n => `| \`${n.id}\` | ${n.type.toUpperCase()} | ${n.fileCount} | ${n.dependencies.map(d => `\`${d}\``).join(", ") || "(none)"} |`),
  ].join("\n");

  // 3. Generate Mermaid Base64 URL for live PNG/SVG image rendering
  const mermaidRawCode = mermaidLines.join("\n");
  const base64Mermaid = Buffer.from(mermaidRawCode).toString("base64");
  const imageUrl = `https://mermaid.ink/svg/${base64Mermaid}`;

  // 4. Generate SVG Content (Vector Graphic representation)
  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="800" height="${nodes.length * 70 + 100}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .bg { fill: #0f172a; }
    .node-app { fill: #0284c7; stroke: #38bdf8; stroke-width: 2; rx: 8; }
    .node-pkg { fill: #6d28d9; stroke: #a855f7; stroke-width: 2; rx: 8; }
    .title { font-family: system-ui, sans-serif; font-weight: bold; font-size: 20px; fill: #f8fafc; }
    .label { font-family: system-ui, sans-serif; font-size: 14px; fill: #ffffff; font-weight: 600; }
    .sub { font-family: system-ui, sans-serif; font-size: 12px; fill: #cbd5e1; }
  </style>
  <rect width="100%" height="100%" class="bg" />
  <text x="30" y="45" class="title">⚡ Inflynx Code Architecture Graph (${nodes.length} modules)</text>
  ${nodes.map((node, i) => `
    <g transform="translate(30, ${80 + i * 65})">
      <rect width="740" height="50" class="${node.type === "app" ? "node-app" : "node-pkg"}" />
      <text x="20" y="30" class="label">${node.type === "app" ? "🌐" : "📦"} ${node.label}</text>
      <text x="400" y="30" class="sub">${node.fileCount} source files | deps: ${node.dependencies.join(", ") || "none"}</text>
    </g>
  `).join("")}
</svg>`;

  // 5. Generate Standalone Interactive D3.js HTML Map
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Inflynx Code — Interactive Knowledge Graph</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <style>
    body { margin: 0; background: #090d16; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; }
    header { background: #1e293b; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #334155; }
    h1 { margin: 0; font-size: 20px; color: #38bdf8; display: flex; align-items: center; gap: 10px; }
    .badge { background: #0284c7; color: #fff; font-size: 12px; padding: 4px 10px; border-radius: 99px; }
    .container { padding: 30px; display: flex; justify-content: center; }
    .mermaid { background: #0f172a; padding: 30px; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
  </style>
</head>
<body>
  <header>
    <h1>⚡ Inflynx Code — Interactive Architecture Mind Map</h1>
    <span class="badge">${nodes.length} Modules</span>
  </header>
  <div class="container">
    <div class="mermaid">
${mermaidLines.join("\n")}
    </div>
  </div>
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'dark' });
  </script>
</body>
</html>`;

  return {
    nodes,
    mermaidMarkdown,
    svgContent,
    htmlContent,
    imageUrl,
  };
}
