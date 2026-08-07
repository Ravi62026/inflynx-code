/**
 * @inflynx/session-store
 * Persistence manager for threads, turns, messages, and rollouts.
 */

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  provider: string;
  title?: string;
}

export interface SessionStore {
  createSession(cwd: string, provider: string, model: string): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(): Promise<SessionRecord[]>;
}
