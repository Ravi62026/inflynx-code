import fs from "fs";
import path from "path";

export interface DebugReportSummary {
  goal: string;
  generatedAt: string;
  healthScore: number;
  totalIssues: number;
  criticalCount: number;
  securityCount: number;
  performanceCount: number;
  minorCount: number;
  rawMarkdown: string;
  reportPath: string;
}

export class DebugEngine {
  private reportPath: string;
  private archiveDir: string;

  constructor(workspaceRoot: string) {
    this.reportPath = path.join(workspaceRoot, ".inflynx", "DEBUG_REPORT.md");
    this.archiveDir = path.join(workspaceRoot, ".inflynx", "reports");
  }

  /** Load and parse active DEBUG_REPORT.md */
  loadActiveReport(): DebugReportSummary | null {
    if (!fs.existsSync(this.reportPath)) return null;
    const raw = fs.readFileSync(this.reportPath, "utf-8");
    return this.parseReportMarkdown(raw);
  }

  /** Archive previous report and write new one */
  writeReport(markdown: string): string {
    if (fs.existsSync(this.reportPath)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const archivePath = path.join(this.archiveDir, `DEBUG-${ts}.md`);
      fs.copyFileSync(this.reportPath, archivePath);
    }

    fs.mkdirSync(path.dirname(this.reportPath), { recursive: true });
    fs.writeFileSync(this.reportPath, markdown, "utf-8");
    return this.reportPath;
  }

  /** List all archived debug reports */
  listHistory(): Array<{ filename: string; path: string; mtime: Date }> {
    if (!fs.existsSync(this.archiveDir)) return [];
    return fs
      .readdirSync(this.archiveDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        filename: f,
        path: path.join(this.archiveDir, f),
        mtime: fs.statSync(path.join(this.archiveDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  private parseReportMarkdown(raw: string): DebugReportSummary {
    const goalMatch = raw.match(/# 🐞 Debug & Code Review Report:? (.+)?/) || raw.match(/# 🐞 Debug & Code Review Report/);
    const scoreMatch = raw.match(/> Overall Code Health Score: (\d+)/);
    const issuesMatch = raw.match(/> Total Issues Found: (\d+)/);
    const generatedMatch = raw.match(/> Generated: (.+)/);
    const countsMatch = raw.match(/\(Critical: (\d+) \| Security: (\d+) \| Performance: (\d+) \| Minor: (\d+)\)/);

    return {
      goal: goalMatch?.[1]?.trim() || "Workspace Audit",
      generatedAt: generatedMatch?.[1]?.trim() || new Date().toISOString(),
      healthScore: scoreMatch ? parseInt(scoreMatch[1], 10) : 100,
      totalIssues: issuesMatch ? parseInt(issuesMatch[1], 10) : 0,
      criticalCount: countsMatch ? parseInt(countsMatch[1], 10) : 0,
      securityCount: countsMatch ? parseInt(countsMatch[2], 10) : 0,
      performanceCount: countsMatch ? parseInt(countsMatch[3], 10) : 0,
      minorCount: countsMatch ? parseInt(countsMatch[4], 10) : 0,
      rawMarkdown: raw,
      reportPath: this.reportPath,
    };
  }
}
