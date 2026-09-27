/**
 * LocalJsonSessionStore
 *
 * ⚠️  NOT a SQL database. This is a zero-dependency, zero-setup fallback for offline/local
 * development when `DATABASE_URL` is not configured (see `createSessionStore()` in `index.ts`).
 * The canonical, production backend is `PostgresSessionStore` (`pnpm docker:up`).
 *
 * ## Layout (Phase 40)
 *
 * It used to hold everything in one `.inflynx/session_store.json` and `writeFileSync` the
 * *whole* structure after *every* message — an O(all-sessions-everything) rewrite per turn,
 * which is both slow and the worst possible thing for a large transcript. It is now an
 * **append-only journal per session**: `.inflynx/sessions/<id>.jsonl`, one JSON object per
 * line (`session` / `message` / `tool` / `telemetry`). Appending a message writes one line.
 * The last `session` line wins for metadata (status, model config); messages and tool
 * executions are read back in file order, which *is* insertion order.
 *
 * Two honesty rules the old store broke (H3):
 *  - a failed write now **throws** — it does not `console.error` and carry on with an
 *    in-memory view the disk never got, which is a silent lie about persistence;
 *  - a process killed mid-append can only ever damage the final line, so replay skips a
 *    trailing line it cannot parse rather than failing the whole session. Every earlier,
 *    fully-written record survives.
 *
 * The previous single-file store is migrated once on startup and left on disk as
 * `session_store.json.migrated` for recovery.
 */

import fs from "fs";
import path from "path";
import type {
  SessionStore,
  SessionRecord,
  StoredMessage,
  StoredToolExecution,
  StoredTokenTelemetry,
  SessionHydration,
  SessionModelConfig,
} from "./types.js";
import { generateSessionId, generateRecordId } from "./types.js";

interface SessionState {
  record: SessionRecord;
  messages: StoredMessage[];
  toolExecutions: StoredToolExecution[];
  telemetry: StoredTokenTelemetry;
}

type JournalLine =
  | { kind: "session"; record: SessionRecord }
  | { kind: "message"; message: StoredMessage }
  | { kind: "tool"; execution: StoredToolExecution }
  | { kind: "telemetry"; telemetry: StoredTokenTelemetry };

const LEGACY_FILE = "session_store.json";

export class LocalJsonSessionStore implements SessionStore {
  private inflynxDir: string;
  private sessionsDir: string;
  private sessions = new Map<string, SessionState>();

  constructor(workspaceRoot: string = process.cwd()) {
    this.inflynxDir = path.join(workspaceRoot, ".inflynx");
    this.sessionsDir = path.join(this.inflynxDir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.migrateLegacyStore();
    this.loadAll();
  }

  private fileFor(sessionId: string): string {
    // The id is our own generated `session_<ts>_<hex>`; guard anyway so a hostile id can
    // never escape the sessions directory via the filename.
    const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(this.sessionsDir, `${safe}.jsonl`);
  }

  // ── persistence primitives (throw on failure — H3) ──────────────────────

  /** Append one journal line. A write error propagates: a swallowed failure is a lie. */
  private appendLine(sessionId: string, line: JournalLine): void {
    fs.appendFileSync(this.fileFor(sessionId), JSON.stringify(line) + "\n", "utf-8");
  }

  /** Rewrite the whole journal for a session — only used by migration, not the hot path. */
  private writeJournal(sessionId: string, lines: JournalLine[]): void {
    const file = this.fileFor(sessionId);
    const tmp = `${file}.tmp`;
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
    fs.writeFileSync(tmp, body, "utf-8");
    fs.renameSync(tmp, file);
  }

  private emptyTelemetry(sessionId: string, createdAt: number): StoredTokenTelemetry {
    return { sessionId, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0, updatedAt: createdAt };
  }

  private freshState(record: SessionRecord): SessionState {
    return { record, messages: [], toolExecutions: [], telemetry: this.emptyTelemetry(record.sessionId, record.createdAt) };
  }

  // ── load & migration ────────────────────────────────────────────────────

  private loadAll(): void {
    let entries: string[];
    try { entries = fs.readdirSync(this.sessionsDir); } catch { return; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      const state = this.readJournal(id);
      if (state) this.sessions.set(id, state);
    }
  }

  /** Fold a journal into state. A trailing half-written line (killed mid-append) is skipped. */
  private readJournal(sessionId: string): SessionState | null {
    const file = this.fileFor(sessionId);
    let raw: string;
    try { raw = fs.readFileSync(file, "utf-8"); } catch { return null; }
    const lines = raw.split("\n");
    // A crash mid-append leaves a partial line at the very end. That one trailing line may
    // be unparseable; anything before it is committed data and must not be silently lost.
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { lastNonEmpty = i; break; } }
    let record: SessionRecord | null = null;
    const messages: StoredMessage[] = [];
    const toolExecutions: StoredToolExecution[] = [];
    let telemetry: StoredTokenTelemetry | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let parsed: JournalLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Only the final (possibly torn) line is tolerated; earlier corruption is a real
        // problem and must surface rather than quietly drop committed messages.
        if (i === lastNonEmpty) continue;
        throw new Error(`LocalJsonSessionStore: journal ${file} is corrupt at line ${i + 1}`);
      }
      switch (parsed.kind) {
        case "session": record = parsed.record; break;
        case "message": messages.push(parsed.message); break;
        case "tool": toolExecutions.push(parsed.execution); break;
        case "telemetry": telemetry = parsed.telemetry; break;
      }
    }
    if (!record) return null;
    return { record, messages, toolExecutions, telemetry: telemetry ?? this.emptyTelemetry(record.sessionId, record.createdAt) };
  }

  private migrateLegacyStore(): void {
    const legacy = path.join(this.inflynxDir, LEGACY_FILE);
    if (!fs.existsSync(legacy)) return;
    // Only migrate if the new store is empty, so a partial migration never double-writes.
    if (this.sessions.size === 0) {
      try {
        const data = JSON.parse(fs.readFileSync(legacy, "utf-8"));
        const sessions: Record<string, SessionRecord> = data.sessions ?? {};
        for (const [id, record] of Object.entries(sessions)) {
          const lines: JournalLine[] = [{ kind: "session", record }];
          for (const m of (data.messages?.[id] ?? []) as StoredMessage[]) lines.push({ kind: "message", message: m });
          for (const t of (data.toolExecutions?.[id] ?? []) as StoredToolExecution[]) lines.push({ kind: "tool", execution: t });
          if (data.telemetry?.[id]) lines.push({ kind: "telemetry", telemetry: data.telemetry[id] });
          this.writeJournal(id, lines);
        }
        fs.renameSync(legacy, `${legacy}.migrated`);
      } catch (err) {
        // A broken legacy file should not block starting with an empty new store; leave it
        // in place for manual recovery rather than deleting anyone's data.
        console.error(`[LocalJsonSessionStore] legacy migration skipped (${(err as Error).message}); old file left intact.`);
      }
    }
  }

  // ── SessionStore ────────────────────────────────────────────────────────

  async createSession(
    cwd: string,
    provider: string,
    model: string,
    activeMode: string = "agent",
    effortLevel: string = "medium",
    title?: string,
    sessionId?: string,
    modelConfig?: Partial<SessionModelConfig>
  ): Promise<SessionRecord> {
    const id = sessionId || generateSessionId();
    const record: SessionRecord = {
      sessionId: id, cwd,
      createdAt: Date.now(), updatedAt: Date.now(),
      provider, model,
      credentialProfileId: modelConfig?.credentialProfileId,
      baseUrl: modelConfig?.baseUrl,
      reasoningEffort: modelConfig?.reasoningEffort,
      actualModel: modelConfig?.actualModel,
      activeMode, effortLevel,
      title: title || `Session in ${path.basename(cwd)}`,
      status: "active",
    };
    this.appendLine(id, { kind: "session", record });
    this.sessions.set(id, this.freshState(record));
    return record;
  }

  async saveMessage(sessionId: string, message: Omit<StoredMessage, "id" | "timestamp" | "sessionId">): Promise<StoredMessage> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      // Not fatal: an orchestrator that lost its session row must still not lose the message,
      // but the caller needs to know it wrote to an orphan id (session-ID mismatch bug).
      console.error(`[LocalJsonSessionStore] saveMessage for unknown session "${sessionId}" — a caller bug; the row is unreachable via getSessionHydration().`);
    }
    const seq = state ? state.messages.length : 0;
    const msg: StoredMessage = { ...message, id: generateRecordId("msg"), sessionId, timestamp: Date.now(), seq };
    this.appendLine(sessionId, { kind: "message", message: msg });
    if (state) { state.messages.push(msg); state.record.updatedAt = msg.timestamp; }
    return msg;
  }

  async saveToolExecution(sessionId: string, execution: Omit<StoredToolExecution, "id" | "timestamp" | "sessionId">): Promise<StoredToolExecution> {
    const state = this.sessions.get(sessionId);
    const record: StoredToolExecution = { ...execution, id: generateRecordId("tool_exec"), sessionId, timestamp: Date.now() };
    this.appendLine(sessionId, { kind: "tool", execution: record });
    if (state) state.toolExecutions.push(record);
    return record;
  }

  async updateTokenTelemetry(sessionId: string, telemetry: Omit<StoredTokenTelemetry, "sessionId" | "updatedAt">): Promise<StoredTokenTelemetry> {
    const record: StoredTokenTelemetry = { sessionId, promptTokens: telemetry.promptTokens, completionTokens: telemetry.completionTokens, reasoningTokens: telemetry.reasoningTokens, estimatedCostUsd: telemetry.estimatedCostUsd, updatedAt: Date.now() };
    this.appendLine(sessionId, { kind: "telemetry", telemetry: record });
    const state = this.sessions.get(sessionId);
    if (state) state.telemetry = record;
    return record;
  }

  async updateSessionModelConfig(sessionId: string, config: SessionModelConfig): Promise<SessionRecord> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Cannot update missing session "${sessionId}".`);
    Object.assign(state.record, {
      provider: config.provider, model: config.model,
      credentialProfileId: config.credentialProfileId, baseUrl: config.baseUrl,
      reasoningEffort: config.reasoningEffort, actualModel: config.actualModel,
      updatedAt: Date.now(),
    });
    this.appendLine(sessionId, { kind: "session", record: state.record });
    return state.record;
  }

  async getSessionHydration(sessionId: string): Promise<SessionHydration | null> {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      session: state.record,
      messages: [...state.messages],
      toolExecutions: [...state.toolExecutions],
      telemetry: { ...state.telemetry },
    };
  }

  async listSessions(cwd?: string): Promise<SessionRecord[]> {
    const list = [...this.sessions.values()].map((s) => s.record).filter((r) => r.status !== "archived");
    const filtered = cwd ? list.filter((s) => s.cwd === cwd) : list;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async updateSessionStatus(sessionId: string, status: SessionRecord["status"]): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Cannot set status on missing session "${sessionId}".`);
    state.record.status = status;
    state.record.updatedAt = Date.now();
    this.appendLine(sessionId, { kind: "session", record: state.record });
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.updateSessionStatus(sessionId, "archived");
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.sessions.has(sessionId)) return false;
    this.sessions.delete(sessionId);
    try { fs.rmSync(this.fileFor(sessionId), { force: true }); } catch { /* already gone */ }
    return true;
  }

  async close(): Promise<void> {
    // No handle to release: every write is a synchronous append, nothing is buffered.
  }
}
