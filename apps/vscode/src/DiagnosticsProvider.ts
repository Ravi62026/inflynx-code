import * as vscode from "vscode";

export interface FindingReport {
  filePath: string;
  line?: number;
  message: string;
  severity: "error" | "warning" | "info";
  ruleId?: string;
}

export class DiagnosticsProvider {
  private collection: vscode.DiagnosticCollection;

  constructor(context: vscode.ExtensionContext) {
    this.collection = vscode.languages.createDiagnosticCollection("inflynx");
    context.subscriptions.push(this.collection);
  }

  setFindings(findings: FindingReport[]): void {
    this.collection.clear();
    const grouped = new Map<string, vscode.Diagnostic[]>();

    for (const f of findings) {
      const line = Math.max(0, (f.line || 1) - 1);
      const range = new vscode.Range(line, 0, line, 1000);

      let severity = vscode.DiagnosticSeverity.Information;
      if (f.severity === "error") {
        severity = vscode.DiagnosticSeverity.Error;
      } else if (f.severity === "warning") {
        severity = vscode.DiagnosticSeverity.Warning;
      }

      const diag = new vscode.Diagnostic(range, `[Inflynx] ${f.message}`, severity);
      diag.source = "Inflynx Code";
      if (f.ruleId) {
        diag.code = f.ruleId;
      }

      if (!grouped.has(f.filePath)) {
        grouped.set(f.filePath, []);
      }
      grouped.get(f.filePath)!.push(diag);
    }

    for (const [filePath, diags] of grouped) {
      this.collection.set(vscode.Uri.file(filePath), diags);
    }
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
