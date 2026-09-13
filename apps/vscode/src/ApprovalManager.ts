import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { InflynxService } from "./InflynxService.js";
import type { ToolApprovalRequestPayload } from "./types.js";

export class ApprovalManager {
  private alwaysApprovedSessions = new Set<string>();
  private pendingApprovals = new Map<string, ToolApprovalRequestPayload>();

  constructor(
    private readonly service: InflynxService,
    private readonly context: vscode.ExtensionContext
  ) {
    this.registerEventListeners();
  }

  private registerEventListeners(): void {
    this.service.on("tool.approval_required", (payload: ToolApprovalRequestPayload) => {
      this.handleApprovalRequest(payload).catch((err) => {
        console.error("[Inflynx ApprovalManager] Error handling approval request:", err);
      });
    });
  }

  async handleApprovalRequest(payload: ToolApprovalRequestPayload): Promise<void> {
    const sessionId = this.service.getCurrentSessionId();
    if (!sessionId) return;

    // Check if auto-approve-all is configured or session is marked always-approved
    const config = vscode.workspace.getConfiguration("inflynx");
    const autoApproveAll = config.get<boolean>("autoApproveAll", false);

    if (autoApproveAll || this.alwaysApprovedSessions.has(sessionId)) {
      await this.service.approveToolCall(sessionId, payload.toolCallId, true);
      return;
    }

    this.pendingApprovals.set(payload.toolCallId, payload);

    if (payload.toolName === "patch_file" || payload.toolName === "write_file") {
      await this.handleFileEditApproval(sessionId, payload);
    } else if (payload.toolName === "execute_shell") {
      await this.handleShellApproval(sessionId, payload);
    } else {
      await this.handleGenericApproval(sessionId, payload);
    }
  }

  private async handleFileEditApproval(sessionId: string, payload: ToolApprovalRequestPayload): Promise<void> {
    const args = payload.args as Record<string, any>;
    const targetFile = String(args.targetFile || args.path || args.file || "unknown_file");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const resolvedPath = path.isAbsolute(targetFile) ? targetFile : path.join(workspaceRoot, targetFile);

    // If diff preview is desired, create temporary file with replacement content and open diff
    let diffOpened = false;
    if (payload.toolName === "patch_file" && args.replacementSnippet) {
      try {
        const originalContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, "utf8") : "";
        const targetSnippet = String(args.targetSnippet || "");
        const replacementSnippet = String(args.replacementSnippet || "");
        const patchedContent = originalContent.includes(targetSnippet)
          ? originalContent.replace(targetSnippet, replacementSnippet)
          : replacementSnippet;

        const tmpFile = path.join(os.tmpdir(), `inflynx_preview_${path.basename(resolvedPath)}`);
        fs.writeFileSync(tmpFile, patchedContent, "utf8");

        const originalUri = vscode.Uri.file(resolvedPath);
        const previewUri = vscode.Uri.file(tmpFile);

        await vscode.commands.executeCommand("vscode.diff", originalUri, previewUri, `Inflynx Diff: ${path.basename(resolvedPath)} (Proposed Edit)`);
        diffOpened = true;
      } catch (err) {
        console.warn("[Inflynx ApprovalManager] Could not open diff editor:", err);
      }
    }

    const choice = await vscode.window.showInformationMessage(
      `Inflynx AI requests approval to modify: ${path.basename(resolvedPath)} (${payload.toolName})`,
      { modal: false },
      "Approve",
      "Deny",
      "Always Approve for Session"
    );

    const approved = choice === "Approve" || choice === "Always Approve for Session";
    if (choice === "Always Approve for Session") {
      this.alwaysApprovedSessions.add(sessionId);
    }

    this.pendingApprovals.delete(payload.toolCallId);
    await this.service.approveToolCall(sessionId, payload.toolCallId, approved);
  }

  private async handleShellApproval(sessionId: string, payload: ToolApprovalRequestPayload): Promise<void> {
    const args = payload.args as Record<string, any>;
    const command = String(args.command || "");

    const choice = await vscode.window.showWarningMessage(
      `Inflynx AI requests permission to execute terminal command:\n\n${command}`,
      { modal: true },
      "Approve",
      "Deny",
      "Always Approve for Session"
    );

    const approved = choice === "Approve" || choice === "Always Approve for Session";
    if (choice === "Always Approve for Session") {
      this.alwaysApprovedSessions.add(sessionId);
    }

    this.pendingApprovals.delete(payload.toolCallId);
    await this.service.approveToolCall(sessionId, payload.toolCallId, approved);
  }

  private async handleGenericApproval(sessionId: string, payload: ToolApprovalRequestPayload): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Inflynx AI requests permission to execute tool: ${payload.toolName}`,
      "Approve",
      "Deny"
    );

    const approved = choice === "Approve";
    this.pendingApprovals.delete(payload.toolCallId);
    await this.service.approveToolCall(sessionId, payload.toolCallId, approved);
  }

  async resolveApprovalFromWebview(toolCallId: string, approved: boolean): Promise<boolean> {
    const sessionId = this.service.getCurrentSessionId();
    if (!sessionId) return false;

    this.pendingApprovals.delete(toolCallId);
    return await this.service.approveToolCall(sessionId, toolCallId, approved);
  }

  clearSessionState(sessionId?: string): void {
    if (sessionId) {
      this.alwaysApprovedSessions.delete(sessionId);
    } else {
      this.alwaysApprovedSessions.clear();
    }
    this.pendingApprovals.clear();
  }
}
