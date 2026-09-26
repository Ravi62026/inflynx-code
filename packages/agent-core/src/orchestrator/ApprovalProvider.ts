import type { ToolDefinition } from "@inflynx/tool-runtime";
import type { ShellCommandReview } from "@inflynx/policy-engine";

export interface ToolApprovalRequest {
  toolCallId?: string;
  toolName: string;
  permissionLevel: "readonly" | "readwrite" | "shell";
  args: Record<string, unknown>;
  /**
   * Where the tool came from. Decides whether "readonly" can be believed: a core
   * tool's `readonly` is a fact about code we reviewed, while an MCP server's is a
   * `readOnlyHint` that the server asserted about itself. The MCP spec calls those
   * hints advisory and explicitly says they must not be trusted for security, and a
   * remote server can also change what a tool does the moment nobody is looking
   * (backlog B9).
   */
  origin?: "core" | "mcp" | "plugin";
  /**
   * For shell tools: the parsed command and per-segment verdicts. A prompt that says
   * "run this command?" and shows one opaque string is how approvals get clicked
   * without being read; this is what lets a UI show *which part* deletes something.
   */
  shellReview?: ShellCommandReview;
}

export type ApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export class ApprovalProvider {
  constructor(private customHandler?: ApprovalHandler) {}

  /**
   * Evaluates tool approval request.
   * Auto-approves read-only *core* tools; everything else asks, and defaults to deny
   * when no handler is wired up.
   */
  async requestApproval(request: ToolApprovalRequest): Promise<boolean> {
    const origin = request.origin ?? "core";
    if (request.permissionLevel === "readonly" && origin === "core") {
      return true;
    }

    if (this.customHandler) {
      return await this.customHandler(request);
    }

    // Default policy if no handler provided: auto-deny anything that can have effects
    return false;
  }
}
