import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { InflynxService } from "./InflynxService.js";
import type { ToolApprovalRequestPayload } from "./types.js";
import { ApprovalRegistry } from "./approval-registry.js";

/**
 * Owns the approval decision path.
 *
 * Exactly one surface prompts per request, and exactly one call can settle it:
 * previously the native notification *and* the webview dialog both fired for the
 * same request, each could answer it, and both resolved against
 * "the session the UI is showing" rather than the session that asked (backlog K9).
 */
export class ApprovalManager {
  private readonly registry = new ApprovalRegistry();
  private readonly alwaysApprovedSessions = new Set<string>();
  private lastSessionId: string | null = null;
  /** Registered by the chat webview when it is live; returns whether it displayed. */
  private webviewPrompt: ((request: ToolApprovalRequestPayload) => boolean) | null = null;

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

    // Unanswered approvals from a previous session must not be answerable later.
    const onSessionChange = (next: string | null) => {
      if (this.lastSessionId && this.lastSessionId !== next) {
        this.registry.forgetSession(this.lastSessionId);
      }
      this.lastSessionId = next;
    };
    this.service.on("session.started", () => onSessionChange(this.service.getCurrentSessionId()));
    this.service.on("session.hydrated", () => onSessionChange(this.service.getCurrentSessionId()));
  }

  setWebviewPrompt(prompt: ((request: ToolApprovalRequestPayload) => boolean) | null): void {
    this.webviewPrompt = prompt;
  }

  async handleApprovalRequest(payload: ToolApprovalRequestPayload): Promise<void> {
    const sessionId = payload.sessionId || this.service.getCurrentSessionId();
    if (!sessionId) {
      console.warn("[Inflynx ApprovalManager] approval event had no session; ignoring");
      return;
    }

    const request: ToolApprovalRequestPayload = { ...payload, sessionId };
    if (!this.registry.track(request)) {
      console.warn(
        `[Inflynx ApprovalManager] duplicate approval event for ${sessionId}/${request.toolCallId}; ignoring`
      );
      return;
    }

    const config = vscode.workspace.getConfiguration("inflynx");
    if (config.get<boolean>("autoApproveAll", false) || this.alwaysApprovedSessions.has(sessionId)) {
      await this.answer({ sessionId, toolCallId: request.toolCallId, approved: true });
      return;
    }

    // Prefer the chat webview; only fall back to a native notification when it is
    // not on screen. Both prompting is what produced two buttons for one decision.
    if (this.webviewPrompt?.(request)) return;

    await this.promptNatively(request);
  }

  /** The single place that settles a request and tells the server about it. */
  async answer(input: { sessionId: string; toolCallId: string; approved: boolean }): Promise<boolean> {
    const outcome = this.registry.resolve(input.sessionId, input.toolCallId, input.approved);
    if (outcome.status === "already-settled") {
      console.warn(
        `[Inflynx ApprovalManager] ${input.sessionId}/${input.toolCallId} was already ` +
        `answered (${outcome.approved ? "approved" : "denied"}); the second answer was ignored.`
      );
      return false;
    }
    if (outcome.status === "unknown-request") {
      console.warn(
        `[Inflynx ApprovalManager] no pending approval ${input.sessionId}/${input.toolCallId}; ` +
        "it may belong to a different session or already timed out."
      );
      return false;
    }
    return await this.service.approveToolCall(input.sessionId, input.toolCallId, input.approved);
  }

  private async promptNatively(request: ToolApprovalRequestPayload): Promise<void> {
    const args = request.args as Record<string, any>;

    if (request.toolName === "patch_file" || request.toolName === "write_file") {
      this.openDiffPreview(request, args);
    }

    const command =
      request.toolName === "execute_shell" ? `\n\n$ ${String(args.command || "")}` : "";
    const choice = await vscode.window.showWarningMessage(
      `Inflynx requests permission to run ${request.toolName} on session ` +
      `${request.sessionId.slice(-8)}${command}`,
      { modal: request.permissionLevel === "shell" },
      "Approve",
      "Deny",
      "Always Approve for Session"
    );

    const approved = choice === "Approve" || choice === "Always Approve for Session";
    if (choice === "Always Approve for Session") {
      this.alwaysApprovedSessions.add(request.sessionId);
    }
    await this.answer({
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      approved,
    });
  }

  /**
   * Uses the tool's real argument names. This previously read
   * `targetSnippet`/`replacementSnippet`, which `patch_file` never sends (it takes
   * `target_code`/`replacement_code`), so the preview silently never appeared and
   * users approved blind edits (backlog K6).
   */
  private openDiffPreview(request: ToolApprovalRequestPayload, args: Record<string, any>): void {
    try {
      const targetFile = String(args.path || args.targetFile || "");
      if (!targetFile) return;

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      const resolvedPath = path.isAbsolute(targetFile) ? targetFile : path.join(workspaceRoot, targetFile);
      const original = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, "utf8") : "";

      let preview = "";
      if (request.toolName === "patch_file") {
        const target = String(args.target_code || "");
        const replacement = String(args.replacement_code || "");
        preview = target && original.includes(target)
          ? original.replace(target, replacement)
          : `${original}\n\n— — — proposed replacement — — —\n${replacement}\n`;
      } else {
        preview = String(args.content ?? "");
      }

      const tmpFile = path.join(os.tmpdir(), `inflynx_preview_${path.basename(resolvedPath)}`);
      fs.writeFileSync(tmpFile, preview, "utf8");
      void vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(resolvedPath),
        vscode.Uri.file(tmpFile),
        `Inflynx: ${path.basename(resolvedPath)} (proposed edit)`
      );
    } catch (err) {
      console.warn("[Inflynx ApprovalManager] Could not open diff editor:", err);
    }
  }

  clearSessionState(sessionId?: string): void {
    if (sessionId) {
      this.alwaysApprovedSessions.delete(sessionId);
      this.registry.forgetSession(sessionId);
    } else {
      this.alwaysApprovedSessions.clear();
      this.registry.clear();
    }
  }
}
