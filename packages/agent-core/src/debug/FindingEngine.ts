export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type FindingCategory =
  | "correctness"
  | "security"
  | "data_integrity"
  | "race_condition"
  | "performance"
  | "reliability";

export interface FindingEvidence {
  reproductionCommand?: string;
  stackTrace?: string;
  codeSnippet?: string;
  verifiedDataFlow?: string;
}

export interface BugFinding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  targetFile: string;
  lineStart?: number;
  lineEnd?: number;
  evidence: FindingEvidence;
  impact: string;
  rootCause: string;
  confidenceScore: number; // 0.0 to 1.0; <0.70 = Hypothesis
  verificationStatus: "hypothesis" | "reproduced" | "fixed" | "unverified";
  suggestedFix?: string;
}

/**
 * @inflynx/agent-core — FindingEngine
 * 
 * Evidence-first bug finding & CodeRabbit review engine.
 * Requires empirical evidence (reproduction commands, stack traces, line ranges)
 * before marking findings as verified defects.
 */
export class FindingEngine {
  private findings = new Map<string, BugFinding>();
  private findingCounter = 1;

  /**
   * Registers a new bug finding.
   * Forces `verificationStatus = "hypothesis"` if confidence < 0.70 or no reproduction evidence is attached.
   */
  addFinding(rawFinding: Omit<BugFinding, "id">): BugFinding {
    const id = `finding_${this.findingCounter++}`;
    const hasEvidence = Boolean(
      rawFinding.evidence.reproductionCommand ||
      rawFinding.evidence.stackTrace ||
      rawFinding.evidence.verifiedDataFlow
    );

    let status = rawFinding.verificationStatus;
    let confidence = Math.min(1.0, Math.max(0.0, rawFinding.confidenceScore));

    if (!hasEvidence || confidence < 0.70) {
      status = "hypothesis";
      if (confidence >= 0.70) confidence = 0.65; // cap hypothesis confidence
    }

    const finding: BugFinding = {
      ...rawFinding,
      id,
      confidenceScore: confidence,
      verificationStatus: status,
    };

    this.findings.set(id, finding);
    return finding;
  }

  getFindings(): BugFinding[] {
    return Array.from(this.findings.values());
  }

  clear(): void {
    this.findings.clear();
    this.findingCounter = 1;
  }

  /**
   * Calculates overall codebase health score (0 to 100).
   */
  calculateHealthScore(): number {
    let score = 100;
    for (const f of this.findings.values()) {
      if (f.verificationStatus === "fixed") continue;

      if (f.severity === "critical") score -= 25;
      else if (f.severity === "high" || f.category === "security") score -= 15;
      else if (f.severity === "medium") score -= 8;
      else if (f.severity === "low") score -= 3;
    }
    return Math.max(0, score);
  }

  /**
   * Generates CodeRabbit-style markdown report formatted for .inflynx/DEBUG_REPORT.md.
   */
  generateMarkdownReport(goal: string): string {
    const list = this.getFindings();
    const healthScore = this.calculateHealthScore();

    const criticalCount = list.filter((f) => f.severity === "critical").length;
    const securityCount = list.filter((f) => f.category === "security" || f.severity === "high").length;
    const performanceCount = list.filter((f) => f.category === "performance").length;
    const minorCount = list.filter((f) => f.severity === "low" || f.severity === "info").length;

    const lines: string[] = [
      `# 🐞 Debug & Code Review Report: ${goal}`,
      `> Generated: ${new Date().toISOString()}`,
      `> Overall Code Health Score: ${healthScore}/100`,
      `> Total Issues Found: ${list.length}`,
      `> Issue Severity Breakdown: (Critical: ${criticalCount} | Security: ${securityCount} | Performance: ${performanceCount} | Minor: ${minorCount})`,
      ``,
      `---`,
      ``,
      `## 📋 Executive Summary & Findings Table`,
      ``,
      `| ID | Severity | Category | Target File | Status | Confidence | Title |`,
      `|---|---|---|---|---|---|---|`,
    ];

    if (list.length === 0) {
      lines.push(`| - | - | - | - | - | - | No issues or defects detected in audit. |`);
    } else {
      for (const f of list) {
        const lineStr = f.lineStart ? `:${f.lineStart}` : "";
        const statusBadge = f.verificationStatus === "reproduced" ? "🔴 Reproduced" : f.verificationStatus === "fixed" ? "✅ Fixed" : "⚠️ Hypothesis";
        lines.push(
          `| \`${f.id}\` | **${f.severity.toUpperCase()}** | \`${f.category}\` | \`${f.targetFile}${lineStr}\` | ${statusBadge} | \`${(f.confidenceScore * 100).toFixed(0)}%\` | ${f.title} |`
        );
      }
    }

    lines.push(``, `---`, ``, `## 🔍 Detailed Findings & Evidence`);

    for (const f of list) {
      lines.push(
        ``,
        `### ${f.id}: ${f.title}`,
        `- **File**: \`${f.targetFile}\`${f.lineStart ? ` (Lines ${f.lineStart}-${f.lineEnd || f.lineStart})` : ""}`,
        `- **Severity**: \`${f.severity.toUpperCase()}\` | **Category**: \`${f.category}\` | **Status**: \`${f.verificationStatus}\``,
        `- **Root Cause**: ${f.rootCause}`,
        `- **Impact**: ${f.impact}`,
        ``
      );

      if (f.evidence.reproductionCommand) {
        lines.push(`**Reproduction Command**:`, `\`\`\`bash`, f.evidence.reproductionCommand, `\`\`\``);
      }

      if (f.evidence.codeSnippet) {
        lines.push(`**Target Code Snippet**:`, `\`\`\`ts`, f.evidence.codeSnippet, `\`\`\``);
      }

      if (f.evidence.stackTrace) {
        lines.push(`**Stack Trace / Error Output**:`, `\`\`\`text`, f.evidence.stackTrace, `\`\`\``);
      }

      if (f.suggestedFix) {
        lines.push(`**Suggested Fix**:`, `\`\`\`ts`, f.suggestedFix, `\`\`\``);
      }
    }

    return lines.join("\n");
  }
}
