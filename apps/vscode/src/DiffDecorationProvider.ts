import * as vscode from "vscode";

export class DiffDecorationProvider {
  private addedDecorationType: vscode.TextEditorDecorationType;
  private modifiedDecorationType: vscode.TextEditorDecorationType;

  constructor(context: vscode.ExtensionContext) {
    this.addedDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(74, 222, 128, 0.15)",
      isWholeLine: true,
      overviewRulerColor: "rgba(74, 222, 128, 0.7)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.modifiedDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(250, 204, 21, 0.15)",
      isWholeLine: true,
      overviewRulerColor: "rgba(250, 204, 21, 0.7)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    context.subscriptions.push(this.addedDecorationType, this.modifiedDecorationType);
  }

  highlightRanges(
    editor: vscode.TextEditor,
    addedRanges: vscode.Range[],
    modifiedRanges: vscode.Range[] = []
  ): void {
    editor.setDecorations(this.addedDecorationType, addedRanges);
    editor.setDecorations(this.modifiedDecorationType, modifiedRanges);
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.addedDecorationType, []);
    editor.setDecorations(this.modifiedDecorationType, []);
  }

  dispose(): void {
    this.addedDecorationType.dispose();
    this.modifiedDecorationType.dispose();
  }
}
