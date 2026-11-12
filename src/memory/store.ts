import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config';

export interface Source {
  title: string;
  url: string;
  publishedDate?: string;
}

export interface StoredTurn {
  /** Absolute UTC timestamp of the turn. */
  ts: string;
  /** The user's timezone at the time of the turn. */
  tz: string;
  role: 'user' | 'assistant';
  kind: 'message' | 'search' | 'verification';
  text: string;
  /** Which session the turn belongs to. */
  sessionId?: string;
  sources?: Source[];
  /** Set on assistant turns that answered a question, used by the re-verify flow. */
  citations?: string[];
}

/**
 * Append-only JSONL conversation store, one file per session, with an
 * in-memory index for retrieval.
 *
 * The index is rebuilt from disk on boot, so nothing is lost on restart.
 */
export class SessionStore {
  private readonly index = new Map<string, StoredTurn[]>();
  private readonly dir = join(config.dataDir, 'sessions');
  /** Sessions already read from disk, so a file is only parsed once. */
  private readonly loaded = new Set<string>();

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.refresh();
  }

  /**
   * Reads any session file not yet in the index.
   *
   * Sessions can be added while the server is running — a file dropped into
   * data/sessions, or a session seeded by another process — so the index is
   * refreshed rather than only built at boot.
   */
  async refresh(): Promise<void> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      if (this.loaded.has(sessionId)) continue;
      this.loaded.add(sessionId);
      this.index.set(sessionId, await this.readFile(sessionId));
    }
  }

  private async readFile(sessionId: string): Promise<StoredTurn[]> {
    const raw = await readFile(join(this.dir, `${sessionId}.jsonl`), 'utf8').catch(() => '');
    const turns: StoredTurn[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        turns.push({ ...(JSON.parse(line) as StoredTurn), sessionId });
      } catch {
        // Skip a partially written last line rather than failing the boot.
      }
    }
    return turns;
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '')}.jsonl`);
  }

  async append(sessionId: string, turn: StoredTurn): Promise<void> {
    const turns = this.index.get(sessionId) ?? [];
    turns.push({ ...turn, sessionId });
    this.index.set(sessionId, turns);
    this.loaded.add(sessionId);
    // Ensure the directory exists on every write: it may have been removed
    // while the server was running, and losing a turn is worse than an extra
    // stat call.
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(sessionId), JSON.stringify(turns[turns.length - 1]) + '\n', 'utf8');
  }

  get(sessionId: string): StoredTurn[] {
    return this.index.get(sessionId) ?? [];
  }

  /** All sessions that have at least one turn. */
  sessionIds(): string[] {
    return [...this.index.keys()];
  }

  /**
   * Seeds a session with prior turns, keeping their original timestamps.
   *
   * Used by POST /api/chat's `history` field so a client can replay a
   * conversation that happened earlier. Turns already present are skipped, so
   * re-sending the same history is idempotent.
   */
  async seed(
    sessionId: string,
    turns: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>,
    tz: string,
  ): Promise<number> {
    // Load the session from disk first, so seeding an existing conversation
    // does not drop its earlier turns from the index.
    await this.refresh();
    const existing = new Set((this.index.get(sessionId) ?? []).map((t) => `${t.ts}|${t.role}|${t.text}`));
    let added = 0;
    for (const turn of turns) {
      const key = `${turn.timestamp}|${turn.role}|${turn.content}`;
      if (existing.has(key)) continue;
      existing.add(key);
      await this.append(sessionId, {
        ts: turn.timestamp,
        tz,
        role: turn.role,
        kind: 'message',
        text: turn.content,
      });
      added++;
    }
    return added;
  }
}

export const store = new SessionStore();
