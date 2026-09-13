import * as vscode from "vscode";

export class InflynxCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Refactor,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const hasSelection = !range.isEmpty;

    if (hasSelection) {
      // 1. Explain Code
      const explainAction = new vscode.CodeAction(
        "Inflynx: Explain selected code",
        vscode.CodeActionKind.Refactor
      );
      explainAction.command = {
        command: "inflynx.explainSelection",
        title: "Explain selected code",
      };
      actions.push(explainAction);

      // 2. Refactor Code
      const refactorAction = new vscode.CodeAction(
        "Inflynx: Refactor selected code",
        vscode.CodeActionKind.Refactor
      );
      refactorAction.command = {
        command: "inflynx.refactorSelection",
        title: "Refactor selected code",
      };
      actions.push(refactorAction);

      // 3. Generate Unit Tests
      const testAction = new vscode.CodeAction(
        "Inflynx: Generate unit tests for selection",
        vscode.CodeActionKind.Refactor
      );
      testAction.command = {
        command: "inflynx.addTestForFunction",
        title: "Generate tests",
      };
      actions.push(testAction);
    }

    // 4. QuickFix for compiler diagnostics
    if (context.diagnostics.length > 0) {
      const fixAction = new vscode.CodeAction(
        "Inflynx: Fix error at cursor",
        vscode.CodeActionKind.QuickFix
      );
      fixAction.isPreferred = true;
      fixAction.command = {
        command: "inflynx.fixError",
        title: "Fix error",
        arguments: [context.diagnostics],
      };
      actions.push(fixAction);
    }

    return actions;
  }
}
