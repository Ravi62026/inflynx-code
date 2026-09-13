import * as vscode from "vscode";

export interface ToolItemDef {
  name: string;
  permission: "readonly" | "readwrite" | "shell";
  description: string;
  parameters: string[];
}

const STATIC_CORE_TOOLS: ToolItemDef[] = [
  {
    name: "read_file",
    permission: "readonly",
    description: "Read whole or partial contents of a file within the workspace.",
    parameters: ["path", "offset", "limit"],
  },
  {
    name: "patch_file",
    permission: "readwrite",
    description: "Surgically apply patches or replacements to a file within workspace.",
    parameters: ["targetFile", "targetSnippet", "replacementSnippet"],
  },
  {
    name: "write_file",
    permission: "readwrite",
    description: "Create a new file or completely overwrite an existing file.",
    parameters: ["targetFile", "content"],
  },
  {
    name: "list_directory",
    permission: "readonly",
    description: "List directory contents recursively or with max depth.",
    parameters: ["path", "depth", "maxResults"],
  },
  {
    name: "search_files",
    permission: "readonly",
    description: "Search file contents using regex or substring match.",
    parameters: ["query", "path", "filePattern"],
  },
  {
    name: "execute_shell",
    permission: "shell",
    description: "Execute a shell command with strict security checks and timeout.",
    parameters: ["command", "timeoutMs"],
  },
  {
    name: "web_search",
    permission: "readonly",
    description: "Query external search engines for live documentation.",
    parameters: ["query", "limit"],
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
