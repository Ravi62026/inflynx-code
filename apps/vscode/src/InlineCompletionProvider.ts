import * as vscode from "vscode";
import type { InflynxService } from "./InflynxService.js";

export class InflynxInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly service: InflynxService) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = vscode.workspace.getConfiguration("inflynx");
    const enabled = config.get<boolean>("inlineCompletions.enabled", false);
    if (!enabled) return undefined;

    if (!this.service.getIsConnected()) return undefined;

    // Check cancellation
    if (token.isCancellationRequested) return undefined;

    const lineText = document.lineAt(position.line).text;
    const prefix = lineText.substring(0, position.character);

    // Only complete if line isn't empty and has meaningful context
    if (prefix.trim().length < 3) return undefined;

    return new Promise((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      const debounceMs = config.get<number>("inlineCompletions.debounceMs", 500);
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) {
          return resolve(undefined);
        }

        // Lightweight inline suggestion logic or heuristic
        resolve(undefined);
      }, debounceMs);
    });
  }
}
