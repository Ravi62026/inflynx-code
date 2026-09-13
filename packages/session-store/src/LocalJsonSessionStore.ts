/**
 * LocalJsonSessionStore
 *
 * ⚠️  NOT a SQL database. This is a flat JSON file persisted to
 * `.inflynx/session_store.json`. It exists purely as a zero-dependency,
 * zero-setup fallback for offline/local development when `DATABASE_URL`
 * is not configured (see `createSessionStore()` in `index.ts`).
 *
 * Do not rely on this for production use: it has no transactions, no
 * concurrent-writer safety, and rewrites the entire file on every write.
 * The canonical, production-grade backend is `PostgresSessionStore`
 * (run via `pnpm docker:up`, see `docker-compose.yml`).
 *
 * (This class was previously — incorrectly — named `SqliteSessionStore`.
 * It never used SQLite. `SqliteSessionStore` is kept as a deprecated type
 * alias in `index.ts` for backward compatibility.)
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
import { generateSessionId } from "./types.js";

interface JsonStoreShape {
  sessions: Record<string, SessionRecord>;
  messages: Record<string, StoredMessage[]>;
  toolExecutions: Record<string, StoredToolExecution[]>;
  telemetry: Record<string, StoredTokenTelemetry>;
}

export class LocalJsonSessionStore implements SessionStore {
  private dbPath: string;
  private data: JsonStoreShape;

  constructor(workspaceRoot: string = process.cwd()) {
    const inflynxDir = path.join(workspaceRoot, ".inflynx");
    fs.mkdirSync(inflynxDir, { recursive: true });
    this.dbPath = path.join(inflynxDir, "session_store.json");
    this.data = this.loadData();
  }

  private loadData(): JsonStoreShape {
    if (fs.existsSync(this.dbPath)) {
      try {
        const raw = fs.readFileSync(this.dbPath, "utf-8");
        return JSON.parse(raw);
      } catch (err) {
        console.error(
          `[LocalJsonSessionStore] Failed to parse ${this.dbPath} — starting from an empty store. ` +
            `Original file was left on disk for manual recovery. Error: ${(err as Error).message}`
        );
      }
    }
    return { sessions: {}, messages: {}, toolExecutions: {}, telemetry: {} };
  }

  /** Atomic write: write to a temp file then rename, so a crash mid-write can never corrupt the store. */
  private saveData(): void {
    try {
      const tmpPath = `${this.dbPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.dbPath);
    } catch (err) {
      console.error(`[LocalJsonSessionStore] Failed to persist ${this.dbPath}: ${(err as Error).message}`);
    }
  }

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
      sessionId: id,
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider,
      model,
      credentialProfileId: modelConfig?.credentialProfileId,
      baseUrl: modelConfig?.baseUrl,
      reasoningEffort: modelConfig?.reasoningEffort,
      actualModel: modelConfig?.actualModel,
      activeMode,
      effortLevel,
      title: title || `Session in ${path.basename(cwd)}`,
      status: "active",
    };

    this.data.sessions[id] = record;
    this.data.messages[id] = [];
    this.data.toolExecutions[id] = [];
    this.data.telemetry[id] = {
      sessionId: id,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
      updatedAt: Date.now(),
    };

    this.saveData();
    return record;
  }

  async saveMessage(sessionId: string, message: Omit<StoredMessage, "id" | "timestamp" | "sessionId">): Promise<StoredMessage> {
    if (!this.data.messages[sessionId]) {
      this.data.messages[sessionId] = [];
    }

    const msg: StoredMessage = {
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sessionId,
      timestamp: Date.now(),
    };

    this.data.messages[sessionId].push(msg);
    if (this.data.sessions[sessionId]) {
      this.data.sessions[sessionId].updatedAt = Date.now();
    } else {
      console.error(
        `[LocalJsonSessionStore] saveMessage() called for sessionId "${sessionId}" which has no session record. ` +
          `This message will be unreachable via getSessionHydration(). This indicates a caller bug (session ID mismatch).`
      );
    }

    this.saveData();
    return msg;
  }

  async saveToolExecution(
    sessionId: string,
    execution: Omit<StoredToolExecution, "id" | "timestamp" | "sessionId">
  ): Promise<StoredToolExecution> {
    if (!this.data.toolExecutions[sessionId]) {
      this.data.toolExecutions[sessionId] = [];
    }

    const execRecord: StoredToolExecution = {
      ...execution,
      id: `tool_exec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sessionId,
      timestamp: Date.now(),
    };

    this.data.toolExecutions[sessionId].push(execRecord);
    this.saveData();
    return execRecord;
  }

  async updateTokenTelemetry(
    sessionId: string,
    telemetry: Omit<StoredTokenTelemetry, "sessionId" | "updatedAt">
  ): Promise<StoredTokenTelemetry> {
    const record: StoredTokenTelemetry = {
      sessionId,
      promptTokens: telemetry.promptTokens,
      completionTokens: telemetry.completionTokens,
      reasoningTokens: telemetry.reasoningTokens,
      estimatedCostUsd: telemetry.estimatedCostUsd,
      updatedAt: Date.now(),
    };

    this.data.telemetry[sessionId] = record;
    this.saveData();
    return record;
  }

  async updateSessionModelConfig(sessionId: string, config: SessionModelConfig): Promise<SessionRecord> {
    const record = this.data.sessions[sessionId];
    if (!record) throw new Error(`Cannot update missing session "${sessionId}".`);

    record.provider = config.provider;
    record.model = config.model;
    record.credentialProfileId = config.credentialProfileId;
    record.baseUrl = config.baseUrl;
    record.reasoningEffort = config.reasoningEffort;
    record.actualModel = config.actualModel;
    record.updatedAt = Date.now();
    this.saveData();
    return record;
  }

  async getSessionHydration(sessionId: string): Promise<SessionHydration | null> {
    const session = this.data.sessions[sessionId];
    if (!session) return null;

    return {
      session,
      messages: this.data.messages[sessionId] || [],
      toolExecutions: this.data.toolExecutions[sessionId] || [],
      telemetry: this.data.telemetry[sessionId] || {
        sessionId,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        estimatedCostUsd: 0,
        updatedAt: session.createdAt,
      },
    };
  }

  async listSessions(cwd?: string): Promise<SessionRecord[]> {
    const list = Object.values(this.data.sessions);
    const filtered = cwd ? list.filter((s) => s.cwd === cwd) : list;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async close(): Promise<void> {
    // No-op: no persistent connection to release for a flat file store.
  }
}
