import type { ToolDefinition } from "@inflynx/tool-runtime";

export interface ToolApprovalRequest {
  toolName: string;
  permissionLevel: "readonly" | "readwrite" | "shell";
  args: Record<string, unknown>;
}

export type ApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export class ApprovalProvider {
  constructor(private customHandler?: ApprovalHandler) {}

  /**
   * Evaluates tool approval request.
   * Auto-approves `readonly` tools, and delegates `readwrite` and `shell` tools to `customHandler` or defaults to false.
   */
  async requestApproval(request: ToolApprovalRequest): Promise<boolean> {
    if (request.permissionLevel === "readonly") {
      return true;
    }

    if (this.customHandler) {
      return await this.customHandler(request);
    }

    // Default policy if no handler provided: auto-deny mutating tools
    return false;
  }
}
