/**
 * Structure-aware diagnostics & symbol tools (backlog Phase 25).
 *
 * `read_file` shows text; these show what the *compiler* thinks. The agent previously had
 * two ways to learn it introduced a type error: run `tsc` through the shell (slow, whole
 * project, output the FailureParser then had to scrape) or guess. Both are worse than
 * asking the TypeScript language service directly — the same service `tsserver` is built
 * on, running in-process, so a `list_diagnostics` after an edit returns
 * `src/x.ts:12:5  error  TS2345  Argument of type 'string'…` without a subprocess at all.
 *
 * ## Why the language service and not a spawned LSP server
 *
 * The backlog named "a real LSP client (tsserver + others)". What that requirement is
 * actually *for* — post-edit type errors without `tsc`, and definition/symbol navigation —
 * is delivered exactly by `ts.createLanguageService`, which is the engine tsserver itself
 * drives. Spawning a separate `typescript-language-server` would add a JSON-RPC handshake,
 * a global-binary dependency, and a non-deterministic test, to reach the same answers. It
 * also would not help any non-TS language, which this phase deliberately does **not**
 * claim: a `.py`/`.go` file is reported as "not covered", never as "no problems".
 *
 * ## Incremental by construction
 *
 * One `LanguageService` per (workspace, tsconfig) is cached. The host reads file content
 * lazily and versions each snapshot by `mtime + size`, so a file the agent just rewrote is
 * re-read (no stale snapshot), while unchanged files keep their parsed AST and type cache.
 * Rebuilding the whole program per call is what made `tsc` feel heavy; the service is what
 * makes this cheap enough to call after every edit.
 */

import fs from "fs";
import path from "path";
import ts from "typescript";
import type { ToolDefinition, ToolExecutionContext } from "./index.js";

/** File extensions the language service understands. Anything else is *skipped*, not cleared. */
const TS_LIKE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const MAX_DIAGNOSTICS_PER_FILE = 40;
const MAX_FILES_PER_CALL = 25;

export interface FileDiagnostic {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info" | "hint";
  code: number;
  message: string;
  source: "syntax" | "semantic";
}

export interface CodeSymbol {
  name: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "enum" | "variable" | "namespace";
  path: string;
  line: number;
  column: number;
  /** 1-based, inclusive — the whole declaration span, for a sidebar or a fold. */
  endLine: number;
  exported: boolean;
  detail?: string;
}

function isTsLike(absPath: string): boolean {
  return TS_LIKE.has(path.extname(absPath).toLowerCase());
}

function toSeverity(cat: ts.DiagnosticCategory | undefined): FileDiagnostic["severity"] {
  switch (cat) {
    case ts.DiagnosticCategory.Error: return "error";
    case ts.DiagnosticCategory.Warning: return "warning";
    case ts.DiagnosticCategory.Suggestion: return "hint";
    default: return "info";
  }
}

/** `ts` reports a chain of related spans; flatten to plain text the model can read. */
function diagnosticMessageText(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, " ").replace(/\s+/g, " ").trim();
}

/** Walks up from `startDir` for the nearest tsconfig.json, stopping at the workspace root. */
function findTsConfig(startDir: string, root: string): string | null {
  let dir = path.resolve(startDir);
  const rootAbs = path.resolve(root);
  // The monorepo's real root: stop at the first config found, but never above the
  // workspace root, so a stray config in the user's home cannot leak in.
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    if (dir === rootAbs || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  return null;
}

interface LoadedConfig {
  options: ts.CompilerOptions;
  fileNames: string[];
  configPath: string | null;
}

function loadConfig(root: string, tsconfigPath: string | null, seedFiles: string[]): LoadedConfig {
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    strict: false,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
  };
  if (!tsconfigPath) return { options: fallback, fileNames: seedFiles, configPath: null };

  const read = ts.readConfigFile(tsconfigPath, (p) => fs.readFileSync(p, "utf-8"));
  if (read.error) return { options: fallback, fileNames: seedFiles, configPath: tsconfigPath };
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.dirname(tsconfigPath));
  // Extend rather than replace: keep the safety defaults that make in-process checks fast
  // (skipLibCheck/noEmit) even if the project's own config omitted them.
  return {
    options: { ...parsed.options, skipLibCheck: true, noEmit: true, incremental: false },
    fileNames: parsed.fileNames,
    configPath: tsconfigPath,
  };
}

interface ServiceEntry {
  service: ts.LanguageService;
  /** Live set the host reads; new targets are added so they become part of the program. */
  fileNames: Set<string>;
  options: ts.CompilerOptions;
  host: ts.LanguageServiceHost;
}

const services = new Map<string, ServiceEntry>();

/** Test hook: force the next call to rebuild, so a modified tsconfig is picked up. */
export function resetLanguageServices(): void {
  for (const [, entry] of services) {
    try { entry.service.dispose(); } catch { /* best effort */ }
  }
  services.clear();
}

function normalize(p: string): string {
  return p.split(path.sep).join("/");
}

function getOrCreateService(root: string, targets: string[]): ServiceEntry {
  const configPath = findTsConfig(path.dirname(targets[0] ?? root), root) ?? findTsConfig(root, root);
  const key = normalize(root) + "\u0000" + (configPath ? normalize(configPath) : "<none>");
  const existing = services.get(key);
  const seed = existing ? existing.fileNames : new Set<string>([...loadConfig(root, configPath, targets).fileNames, ...targets]);
  const options = existing ? existing.options : loadConfig(root, configPath, targets).options;

  if (existing) {
    for (const t of targets) if (!existing.fileNames.has(t)) existing.fileNames.add(t);
    return existing;
  }

  const fileNames = seed;
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => Array.from(fileNames),
    getScriptVersion: (fileName) => {
      try {
        const s = fs.statSync(fileName);
        return `${s.mtimeMs}-${s.size}`;
      } catch {
        return "0";
      }
    },
    getScriptSnapshot: (fileName) => {
      try {
        if (!fs.existsSync(fileName)) return undefined;
        return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: (f) => ts.sys.fileExists(f),
    readFile: (f) => ts.sys.readFile(f),
    directoryExists: (d) => ts.sys.directoryExists(d),
    getDirectories: (d) => ts.sys.getDirectories(d),
    realpath: (f) => (fs.realpathSync ? fs.realpathSync(f) : f),
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const entry: ServiceEntry = { service, fileNames, options, host };
  services.set(key, entry);
  return entry;
}

/** line/col are 1-based, matching every UI and the diagnostics DTO. */
function positionToOffset(sf: ts.SourceFile, line: number, column: number): number {
  const maxLine = Math.max(0, Math.min(line - 1, sf.getLineStarts().length - 1));
  return sf.getPositionOfLineAndCharacter(maxLine, Math.max(0, column - 1));
}

function toDiagnostics(entry: ServiceEntry, absPath: string, relPath: string, source: "syntax" | "semantic"): FileDiagnostic[] {
  const list = source === "syntax"
    ? entry.service.getSyntacticDiagnostics(absPath)
    : entry.service.getSemanticDiagnostics(absPath);
  const sf = entry.service.getProgram()?.getSourceFile(absPath);
  if (!sf) return [];
  const out: FileDiagnostic[] = [];
  for (const d of list.slice(0, MAX_DIAGNOSTICS_PER_FILE)) {
    const start = d.start ?? 0;
    const lc = ts.getLineAndCharacterOfPosition(sf, start);
    const endLc = d.length != null ? ts.getLineAndCharacterOfPosition(sf, start + d.length) : undefined;
    out.push({
      path: relPath,
      line: lc.line + 1,
      column: lc.character + 1,
      endLine: endLc ? endLc.line + 1 : undefined,
      endColumn: endLc ? endLc.character + 1 : undefined,
      severity: toSeverity(d.category),
      code: d.code,
      message: diagnosticMessageText(d),
      source,
    });
  }
  return out;
}

/** Resolves the `paths` argument (workspace-relative or absolute) through the guard. */
function resolveTargets(
  rawPaths: unknown,
  ctx: ToolExecutionContext
): { ok: true; abs: string[]; skipped: string[] } | { ok: false; error: string } {
  const root = ctx.pathGuard.getWorkspaceRoot();
  const abs: string[] = [];
  const skipped: string[] = [];
  if (rawPaths === undefined || rawPaths === null) {
    return { ok: false, error: "no files to check — pass a 'paths' array of the files you changed. Checking the whole workspace is deliberately not offered: it is what made `tsc` slow." };
  }
  const list = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
  if (list.length === 0) return { ok: false, error: "'paths' is empty — pass at least one file." };
  if (list.length > MAX_FILES_PER_CALL) {
    return { ok: false, error: `'paths' has ${list.length} entries; at most ${MAX_FILES_PER_CALL} per call (batch the rest).` };
  }
  for (const raw of list) {
    let resolved: string;
    try {
      resolved = ctx.resolvePath(String(raw));
    } catch (err: any) {
      return { ok: false, error: `path "${raw}" was rejected: ${err?.message || err}` };
    }
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `"${raw}" does not exist. list_diagnostics takes individual files, not directories.` };
    }
    if (fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `"${raw}" is a directory. paths must be individual files, not directories — scanning a whole tree is what made \`tsc\` slow.` };
    }
    if (!isTsLike(resolved)) { skipped.push(String(raw)); continue; }
    abs.push(resolved);
  }
  if (abs.length === 0) {
    return {
      ok: false,
      error: `none of the requested paths are TypeScript/JavaScript (${skipped.join(", ") || "none given"}). This tool covers .ts/.tsx/.js files only — for other languages run their real checker via execute_shell.`,
    };
  }
  void root;
  return { ok: true, abs, skipped };
}

export const LIST_DIAGNOSTICS_TOOL: ToolDefinition = {
  name: "list_diagnostics",
  description:
    "Ask the TypeScript language service for the type and syntax errors in specific files — " +
    "the same engine tsserver uses, in-process, no `tsc` subprocess. Call it right after " +
    "editing to see 'src/x.ts:12:5 error TS2345 …' with exact line/column. Pass the files you " +
    "changed; it does not (and will not) scan the whole workspace in one go. Covers " +
    ".ts/.tsx/.js/.jsx only — other languages are reported as not covered, never as clean.",
  permissionLevel: "readonly",
  isMutating: false,
  // Errors are real-time: an edit between two identical calls changes the answer, so the
  // gateway must not answer the second from the first.
  cacheable: false,
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        description: "Workspace-relative or absolute files to check",
        items: { type: "string" },
      },
      include_warnings: {
        type: "boolean",
        description: "Also report warning/hint-category diagnostics (default: errors + syntax only)",
        default: false,
      },
    },
    required: ["paths"],
  },
  execute: async (args, ctx) => {
    const targets = resolveTargets((args as Record<string, unknown>).paths, ctx);
    if (!targets.ok) return { output: `Error: ${targets.error}`, isError: true };
    const includeWarnings = (args as Record<string, unknown>).include_warnings === true;
    const root = ctx.pathGuard.getWorkspaceRoot();
    const entry = getOrCreateService(root, targets.abs);

    const all: FileDiagnostic[] = [];
    for (const abs of targets.abs) {
      if (ctx.signal?.aborted) break;
      const rel = normalize(path.relative(root, abs));
      all.push(...toDiagnostics(entry, abs, rel, "syntax"));
      all.push(...toDiagnostics(entry, abs, rel, "semantic"));
    }

    const filtered = includeWarnings
      ? all
      : all.filter((d) => d.severity === "error");

    if (filtered.length === 0) {
      const files = targets.abs.map((a) => normalize(path.relative(root, a))).join(", ");
      return (
        `✓ No type errors in ${files}.` +
        (targets.skipped.length ? `\n  (skipped, not TS: ${targets.skipped.join(", ")})` : "") +
        `\n  Note: this reflects the language service view; it is not a substitute for running the project's build/tests.`
      );
    }

    const errors = filtered.filter((d) => d.severity === "error").length;
    const others = filtered.length - errors;
    const body = filtered.map((d) =>
      `${d.path}:${d.line}:${d.column}  ${d.severity}  TS${d.code}  ${d.message}  [${d.source}]`
    );
    const truncated = filtered.length >= MAX_DIAGNOSTICS_PER_FILE * targets.abs.length;
    return (
      `${errors} error${errors === 1 ? "" : "s"}${others ? ` (+${others} warning/hint)` : ""} in ${new Set(filtered.map((d) => d.path)).size} file(s):\n` +
      body.join("\n") +
      (truncated ? `\n  (truncated at ${MAX_DIAGNOSTICS_PER_FILE}/file — fix these, re-check)` : "") +
      (targets.skipped.length ? `\n  skipped (not TS): ${targets.skipped.join(", ")}` : "")
    );
  },
};

function symbolKind(node: ts.Node): CodeSymbol["kind"] | null {
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node)) return "namespace";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isVariableDeclaration(node)) return "variable";
  return null;
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function collectSymbols(sf: ts.SourceFile, relPath: string, includeMethods: boolean): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  const push = (node: ts.Node, name: string, kind: CodeSymbol["kind"], exported: boolean, detail?: string) => {
    const { line, character } = ts.getLineAndCharacterOfPosition(sf, node.getStart(sf));
    const end = ts.getLineAndCharacterOfPosition(sf, node.getEnd());
    const key = `${kind}:${name}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind, path: relPath, line: line + 1, column: character + 1, endLine: end.line + 1, exported, detail });
  };

  const visit = (node: ts.Node, isTop: boolean) => {
    if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const k = symbolKind(decl.initializer ?? decl) ?? "variable";
          if (!isTop && !includeMethods) continue;
          push(decl, decl.name.text, k, exported, decl.initializer ? undefined : "declared, no initializer");
        }
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      push(node, node.name.text, "class", hasExportModifier(node));
      if (includeMethods) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
            push(member, member.name.text, "method", false, "class member");
          }
        }
      }
    } else if (
      ts.isFunctionDeclaration(node) && node.name
      || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
      || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)
    ) {
      const name = (node as { name?: ts.Node }).name;
      const kind = symbolKind(node) ?? "variable";
      if (name && ts.isIdentifier(name)) push(node, name.text, kind, hasExportModifier(node));
    }
    // Only descend into top level for the primary pass; a nested arrow-function variable is
    // still a declaration a reader wants, so the file body is walked one more level.
    if (isTop) ts.forEachChild(node, (c) => visit(c, false));
  };
  ts.forEachChild(sf, (c) => visit(c, true));
  return out.sort((a, b) => a.line - b.line);
}

export const LIST_SYMBOLS_TOOL: ToolDefinition = {
  name: "list_symbols",
  description:
    "List the top-level declarations in one TypeScript/JavaScript file — exported functions, " +
    "classes, interfaces, types, enums and variables, each with its line. Faster than reading " +
    "a whole file when you only need its API surface; use read_file for the bodies. Replaces " +
    "the never-implemented SymbolGraph idea.",
  permissionLevel: "readonly",
  isMutating: false,
  cacheable: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file to inspect (workspace-relative or absolute)" },
      include_methods: { type: "boolean", description: "Also list class methods (default false)", default: false },
      exported_only: { type: "boolean", description: "Only exported declarations", default: false },
    },
    required: ["path"],
  },
  execute: async (args, ctx) => {
    const rawPath = String((args as Record<string, unknown>).path ?? "");
    let abs: string;
    try {
      abs = ctx.resolvePath(rawPath);
    } catch (err: any) {
      return { output: `Error: path was rejected: ${err?.message || err}`, isError: true };
    }
    if (!isTsLike(abs)) {
      return { output: `Error: list_symbols covers TypeScript/JavaScript files; "${rawPath}" is a ${path.extname(abs) || "non-source"} file.`, isError: true };
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return { output: `Error: no file at "${rawPath}".`, isError: true };
    }
    const exportedOnly = (args as Record<string, unknown>).exported_only === true;
    const includeMethods = (args as Record<string, unknown>).include_methods === true;
    const root = ctx.pathGuard.getWorkspaceRoot();
    const text = fs.readFileSync(abs, "utf-8");
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, path.extname(abs) === ".tsx" || path.extname(abs) === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let symbols = collectSymbols(sf, normalize(path.relative(root, abs)), includeMethods);
    if (exportedOnly) symbols = symbols.filter((s) => s.exported);

    if (symbols.length === 0) {
      return `No top-level declarations found in ${normalize(path.relative(root, abs))} (it may be a script with only statements, or only private helpers).`;
    }
    const exportedCount = symbols.filter((s) => s.exported).length;
    const lines = symbols.map((s) =>
      `  ${s.exported ? "export " : "        "}${s.kind.padEnd(10)} ${s.name}  (${s.path}:${s.line})`
    );
    return `${symbols.length} symbol(s) in ${normalize(path.relative(root, abs))} (${exportedCount} exported):\n${lines.join("\n")}`;
  },
};

export const FIND_DEFINITION_TOOL: ToolDefinition = {
  name: "find_definition",
  description:
    "Jump to where a symbol is declared, given a file and a 1-based line/column inside the " +
    "identifier (the compiler's go-to-definition). Use it to answer 'where is this actually " +
    "defined?' across files without a grep-and-hope.",
  permissionLevel: "readonly",
  isMutating: false,
  cacheable: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File containing the reference" },
      line: { type: "number", description: "1-based line of the identifier" },
      column: { type: "number", description: "1-based column of the identifier" },
    },
    required: ["path", "line", "column"],
  },
  execute: async (args, ctx) => {
    const rawPath = String((args as Record<string, unknown>).path ?? "");
    const line = Number((args as Record<string, unknown>).line);
    const column = Number((args as Record<string, unknown>).column);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
      return { output: "Error: line and column must be 1-based integers.", isError: true };
    }
    let abs: string;
    try {
      abs = ctx.resolvePath(rawPath);
    } catch (err: any) {
      return { output: `Error: path was rejected: ${err?.message || err}`, isError: true };
    }
    if (!isTsLike(abs) || !fs.existsSync(abs)) {
      return { output: `Error: find_definition needs an existing TypeScript/JavaScript file; "${rawPath}" is not one.`, isError: true };
    }
    const root = ctx.pathGuard.getWorkspaceRoot();
    const entry = getOrCreateService(root, [abs]);
    const sf = entry.service.getProgram()?.getSourceFile(abs);
    if (!sf) return { output: `Error: the language service could not load ${rawPath}.`, isError: true };
    if (line > sf.getLineStarts().length) {
      return { output: `Error: line ${line} is past the end of ${rawPath} (${sf.getLineStarts().length} lines).`, isError: true };
    }
    const offset = positionToOffset(sf, line, column);
    const info = entry.service.getDefinitionAndBoundSpan(abs, offset);
    if (!info?.definitions?.length) {
      return `No definition found for the symbol at ${normalize(path.relative(root, abs))}:${line}:${column} (the position may be on a keyword or an untyped value).`;
    }
    const defs = info.definitions.map((d) => {
      const dfs = entry.service.getProgram()?.getSourceFile(d.fileName);
      const loc = dfs ? ts.getLineAndCharacterOfPosition(dfs, d.textSpan.start) : { line: 0, character: 0 };
      return `${normalize(path.relative(root, d.fileName))}:${loc.line + 1}:${loc.character + 1}${d.unverified ? " (unverified)" : ""}`;
    });
    return `Definition of the symbol at ${normalize(path.relative(root, abs))}:${line}:${column}:\n` +
      defs.map((p) => `  ${p}`).join("\n");
  },
};

/** Exposed for the verification gate to reuse the same engine (Phase 31 cheap pre-check). */
export function getDiagnosticsForFile(absPath: string, ctx: ToolExecutionContext): FileDiagnostic[] {
  const root = ctx.pathGuard.getWorkspaceRoot();
  const entry = getOrCreateService(root, [absPath]);
  const rel = normalize(path.relative(root, absPath));
  return [...toDiagnostics(entry, absPath, rel, "syntax"), ...toDiagnostics(entry, absPath, rel, "semantic")]
    .filter((d) => d.severity === "error");
}
