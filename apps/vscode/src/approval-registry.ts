/**
 * Approval request state, kept free of any `vscode` import so it can actually be
 * unit-tested (the previous logic lived inside `ApprovalManager`, which cannot be
 * constructed outside an extension host).
 *
 * Two bugs this shape is designed to make impossible:
 *
 *   1. **Double resolution.** The native notification and the webview dialog both
 *      fired for the same request and either could answer it. `resolve()` is now
 *      the single entry point and answers exactly once — later calls are reported
 *      as already-settled instead of silently re-deciding.
 *   2. **Cross-session resolution.** The manager used "the session the UI happens
 *      to be showing" as the target, so an approval belonging to session A could be
 *      answered against session B (or never answered at all). Requests now carry
 *      their own session id.
 */

export interface ApprovalRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  permissionLevel: string;
}

export type ApprovalOutcome =
  | { status: "resolved"; approved: boolean }
  | { status: "already-settled"; approved: boolean | undefined }
  | { status: "unknown-request" };

export class ApprovalRegistry {
  private pending = new Map<string, ApprovalRequest>();
  /** Settled decisions, kept briefly so a duplicate answer can be reported honestly. */
  private settled = new Map<string, boolean>();

  /** Registers a request. Returns false when the same key is still outstanding. */
  track(request: ApprovalRequest): boolean {
    const key = ApprovalRegistry.keyFor(request.sessionId, request.toolCallId);
    if (this.pending.has(key)) return false;
    this.pending.set(key, request);
    this.settled.delete(key);
    return true;
  }

  /**
   * Answers a request exactly once. Any second answer — from the other UI surface,
   * a retried HTTP call, or a stale click — reports what was already decided rather
   * than flipping it.
   */
  resolve(sessionId: string, toolCallId: string, approved: boolean): ApprovalOutcome {
    const key = ApprovalRegistry.keyFor(sessionId, toolCallId);
    if (!this.pending.delete(key)) {
      if (this.settled.has(key)) {
        return { status: "already-settled", approved: this.settled.get(key) };
      }
      return { status: "unknown-request" };
    }
    this.settled.set(key, approved);
    return { status: "resolved", approved };
  }

  /** Abandon everything for a session (abort, session switch, view teardown). */
  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of [...this.pending.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.pending.delete(key);
      // An unanswered request is a denial, and must stay denied if another surface
      // answers it late.
      this.settled.set(key, false);
    }
  }

  clear(): void {
    this.pending.clear();
    this.settled.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  isPending(sessionId: string, toolCallId: string): boolean {
    return this.pending.has(ApprovalRegistry.keyFor(sessionId, toolCallId));
  }

  private static keyFor(sessionId: string, toolCallId: string): string {
    return `${sessionId}::${toolCallId}`;
  }
}
