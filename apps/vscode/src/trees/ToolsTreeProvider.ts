import * as vscode from "vscode";

export interface ToolItemDef {
  name: string;
  permission: "readonly" | "readwrite" | "shell";
  description: string;
  parameters: string[];
}

// K6 (Phase 47): this list previously advertised `targetFile`/`targetSnippet`/`replacementSnippet` and
// `offset`/`limit` — names no tool sends. That is what made the diff preview silently never appear
// and the sidebar lie about the schema. These now mirror the real `CORE_TOOLS` parameter keys; keep
// them in sync (the tools tree is a display affordance, not the execution path).
const STATIC_CORE_TOOLS: ToolItemDef[] = [
  {
    name: "read_file",
    permission: "readonly",
    description: "Read whole or partial contents of a file within the workspace.",
    parameters: ["path", "start_line", "end_line"],
  },
  {
    name: "patch_file",
    permission: "readwrite",
    description: "Surgically apply patches or replacements to a file within workspace.",
    parameters: ["path", "target_code", "replacement_code"],
  },
  {
    name: "write_file",
    permission: "readwrite",
    description: "Create a new file or completely overwrite an existing file.",
    parameters: ["path", "content"],
  },
  {
    name: "list_directory",
    permission: "readonly",
    description: "List directory contents recursively or with max depth.",
    parameters: ["path", "depth"],
  },
  {
    name: "search_files",
    permission: "readonly",
    description: "Search file contents using regex or substring match.",
    parameters: ["pattern", "path", "file_glob", "case_insensitive"],
  },
  {
    name: "execute_shell",
    permission: "shell",
    description: "Execute a shell command with strict security checks and timeout.",
    parameters: ["command", "cwd", "timeout_ms", "background"],
  },
  {
    name: "web_search",
    permission: "readonly",
    description: "Query external search engines for live documentation.",
    parameters: ["query", "max_results"],
  },
  {
    name: "fetch_url",
    permission: "readonly",
    description: "Fetch and extract text content from a web URL.",
    parameters: ["url"],
  },
];

export class ToolTreeItem extends vscode.TreeItem {
  constructor(public readonly tool: ToolItemDef) {
    super(tool.name, vscode.TreeItemCollapsibleState.None);

    this.description = `[${tool.permission}]`;
    this.tooltip = `${tool.name} (${tool.permission})\n${tool.description}\nParams: ${tool.parameters.join(", ")}`;

    switch (tool.permission) {
      case "readonly":
        this.iconPath = new vscode.ThemeIcon("eye", new vscode.ThemeColor("charts.blue"));
        break;
      case "readwrite":
        this.iconPath = new vscode.ThemeIcon("edit", new vscode.ThemeColor("charts.yellow"));
        break;
      case "shell":
        this.iconPath = new vscode.ThemeIcon("terminal", new vscode.ThemeColor("charts.red"));
        break;
    }
  }
}

export class ToolsTreeProvider implements vscode.TreeDataProvider<ToolTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ToolTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ToolTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ToolTreeItem): Promise<ToolTreeItem[]> {
    if (element) return Promise.resolve([]);
    return Promise.resolve(STATIC_CORE_TOOLS.map((t) => new ToolTreeItem(t)));
  }
}
