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
