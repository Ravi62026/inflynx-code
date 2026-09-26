/**
 * @inflynx/policy-engine — shell execution audit log.
 *
 * The counterpart to the rule engine. Once a shell can run anything that is not
 * explicitly denied, "why is my repo behaving like this?" and "what did the agent do
 * while I wasn't reading the transcript?" both need a real answer, and neither can
 * come from reconstructing a chat log. The backlog risk register pairs these two on
 * purpose: an allow/deny engine without an audit trail is a control nobody can
 * review after the fact (Phase 20).
 *
 * Appended as JSONL to `.inflynx/audit/shell.jsonl` in the workspace, mode 0600.
 *
 * What is deliberately *not* stored: the output. It is already in the session
 * transcript, it can be megabytes, and it is the most likely place for a secret to
 * surface. A hash plus a byte count is enough to correlate an entry with a run.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type { ShellDecision, ShellFeatures, SegmentVerdict } from "./shell-rules.js";

export type ShellApprovalSource = "rule:allow" | "user:prompt" | "user:session-rule" | "flag:auto-approve" | "denied";

export interface ShellAuditEntry {
  ts: number;
  sessionId?: string;
  cwd: string;
  command: string;
  decision: ShellDecision;
  approvedBy: ShellApprovalSource;
  verdicts: Array<{ text: string; decision: ShellDecision; reason: string }>;
  features: Pick<
    ShellFeatures,
    "writeRedirections" | "readRedirections" | "substitutions" | "subshellCount" | "background" | "envAssignments" | "variableReferences"
  >;
  exitCode?: number | null;
  durationMs?: number;
  outputBytes?: number;
  outputSha256?: string;
  error?: string;
}

export const SHELL_AUDIT_RELATIVE_PATH = path.join(".inflynx", "audit", "shell.jsonl");

export function getShellAuditPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, SHELL_AUDIT_RELATIVE_PATH);
}

/**
 * Best-effort append. An audit failure never blocks or alters the command it is
 * supposed to be recording — a logging bug must not turn into a failed build — but it
 * does say so on stderr, because a silently missing audit trail is its own incident.
 */
export function appendShellAudit(workspaceRoot: string, entry: ShellAuditEntry): void {
  try {
    const file = getShellAuditPath(workspaceRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch (err: any) {
    console.warn(
      `[policy-engine] could not write the shell audit log (${err?.message || err}). ` +
      `The command proceeded; the record of it did not.`
    );
  }
}

/** Builds the parts of an entry that are known before a command runs. */
export function auditFieldsFromReview(review: {
  command: string;
  decision: ShellDecision;
  verdicts: SegmentVerdict[];
  features: ShellFeatures;
}): Pick<ShellAuditEntry, "command" | "decision" | "verdicts" | "features"> {
  return {
    command: review.command,
    decision: review.decision,
    verdicts: review.verdicts.map((v) => ({ text: v.text, decision: v.decision, reason: v.reason })),
    features: review.features,
  };
}

/** Fingerprint of output, so an entry can be matched to a transcript row. */
export function hashShellOutput(output: string): { outputBytes: number; outputSha256: string } {
  return {
    outputBytes: Buffer.byteLength(output, "utf-8"),
    outputSha256: createHash("sha256").update(output).digest("hex").slice(0, 16),
  };
}

export interface ShellAuditRecord {
  ts: number;
  command: string;
  decision: ShellDecision;
  approvedBy: ShellApprovalSource;
  exitCode?: number | null;
}

/**
 * Reads back the log for `/security` and post-hoc review. Tolerates a truncated last
 * line (a killed process can leave one), which is the whole reason for JSONL.
 */
export function readShellAudit(workspaceRoot: string, limit = 50): ShellAuditRecord[] {
  try {
    const file = getShellAuditPath(workspaceRoot);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-limit).flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return [{
          ts: Number(parsed.ts) || 0,
          command: String(parsed.command || ""),
          decision: parsed.decision as ShellDecision,
          approvedBy: parsed.approvedBy as ShellApprovalSource,
          exitCode: parsed.exitCode ?? null,
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
