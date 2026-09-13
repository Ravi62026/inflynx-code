export interface DiagnosticError {
  filePath?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  severity: "error" | "warning";
  rawOutput?: string;
}

/**
 * @inflynx/agent-core — FailureParser
 * 
 * Compiler and test runner output parser. Extracts structured file locations,
 * line numbers, error codes, and diagnostic messages from raw stdout/stderr.
 */
export class FailureParser {
  /**
   * Parses TypeScript compiler output (tsc).
   * Patterns matched:
   *   src/index.ts(12,5): error TS2307: Cannot find module...
   *   src/index.ts:12:5 - error TS2307: Cannot find module...
   */
  static parseTypeScriptErrors(output: string): DiagnosticError[] {
    const errors: DiagnosticError[] = [];
    const lines = output.split("\n");

    const pattern1 = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
    const pattern2 = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

    for (const line of lines) {
      const trimmed = line.trim();
      let match = trimmed.match(pattern1) || trimmed.match(pattern2);
      if (match) {
        errors.push({
          filePath: match[1].trim(),
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          severity: match[4] === "warning" ? "warning" : "error",
          code: match[5],
          message: match[6].trim(),
          rawOutput: trimmed,
        });
      }
    }

    return errors;
  }

  /**
   * Parses Jest / Vitest test failure output.
   */
  static parseTestRunnerErrors(output: string): DiagnosticError[] {
    const errors: DiagnosticError[] = [];
    const lines = output.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("FAIL ") || trimmed.startsWith("✕ ") || trimmed.includes("AssertionError:")) {
        const fileMatch = trimmed.match(/(?:FAIL|✕)\s+([^\s]+\.(?:test|spec)\.[t|j]sx?)/);
        errors.push({
          filePath: fileMatch ? fileMatch[1] : undefined,
          message: trimmed,
          severity: "error",
          rawOutput: trimmed,
        });
      }
    }

    return errors;
  }

  /**
   * Parses ESLint output.
   * Pattern matched: src/index.ts:10:15: error Unexpected console statement (no-console)
   */
  static parseEsLintErrors(output: string): DiagnosticError[] {
    const errors: DiagnosticError[] = [];
    const lines = output.split("\n");
    const pattern = /^(.+?):(\d+):(\d+):\s+(error|warning)\s+(.+)$/;

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(pattern);
      if (match) {
        errors.push({
          filePath: match[1].trim(),
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          severity: match[4] === "warning" ? "warning" : "error",
          message: match[5].trim(),
          rawOutput: trimmed,
        });
      }
    }

    return errors;
  }

  /**
   * Unified parser combining compiler, test runner, and lint parser rules.
   */
  static parseOutput(stdout: string, stderr: string): DiagnosticError[] {
    const combined = `${stdout}\n${stderr}`;
    const tsErrors = this.parseTypeScriptErrors(combined);
    const testErrors = this.parseTestRunnerErrors(combined);
    const lintErrors = this.parseEsLintErrors(combined);

    const all = [...tsErrors, ...testErrors, ...lintErrors];

    // Deduplicate by message and location
    const unique = new Map<string, DiagnosticError>();
    for (const err of all) {
      const key = `${err.filePath || ""}:${err.line || 0}:${err.message}`;
      if (!unique.has(key)) {
        unique.set(key, err);
      }
    }

    // Fallback: if stderr contains explicit error text but no structured regex matched
    if (unique.size === 0 && stderr.trim()) {
      const stderrLines = stderr.trim().split("\n").filter((l) => l.toLowerCase().includes("error") || l.includes("FAIL"));
      for (const line of stderrLines.slice(0, 5)) {
        unique.set(line, {
          message: line.trim(),
          severity: "error",
          rawOutput: line.trim(),
        });
      }
    }

    return Array.from(unique.values());
  }
}
