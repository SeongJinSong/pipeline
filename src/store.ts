import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type AppStatus = "creating" | "ready" | "failed";
export type ChangeStatus = "running" | "preview" | "merged" | "closed" | "failed";

export interface AppRecord {
  id: number;
  slug: string;
  name: string;
  idea: string;
  spec_json: string;
  repo: string; // owner/name
  vercel_project_id: string | null;
  production_url: string | null;
  slack_channel_id: string;
  needs_backend: number;
  status: AppStatus;
  created_by: string;
  created_at: string;
}

export interface ChangeRecord {
  id: number;
  app_id: number;
  slack_thread_ts: string;
  requested_by: string;
  request: string;
  branch: string;
  pr_number: number | null;
  preview_url: string | null;
  status: ChangeStatus;
  summary: string | null;
  cost_usd: number;
  created_at: string;
}

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true });
    this.db = new Database(dataDir === ":memory:" ? ":memory:" : join(dataDir, "pipeline.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        idea TEXT NOT NULL,
        spec_json TEXT NOT NULL DEFAULT '{}',
        repo TEXT NOT NULL,
        vercel_project_id TEXT,
        production_url TEXT,
        slack_channel_id TEXT NOT NULL DEFAULT '',
        needs_backend INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'creating',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id),
        slack_thread_ts TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        request TEXT NOT NULL,
        branch TEXT NOT NULL,
        pr_number INTEGER,
        preview_url TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        summary TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS changes_thread ON changes(app_id, slack_thread_ts);
    `);
  }

  createApp(a: Pick<AppRecord, "slug" | "name" | "idea" | "repo" | "created_by">): AppRecord {
    const info = this.db
      .prepare(`INSERT INTO apps (slug, name, idea, repo, created_by) VALUES (?, ?, ?, ?, ?)`)
      .run(a.slug, a.name, a.idea, a.repo, a.created_by);
    return this.getApp(Number(info.lastInsertRowid))!;
  }

  updateApp(id: number, patch: Partial<Omit<AppRecord, "id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE apps SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }

  getApp(id: number): AppRecord | undefined {
    return this.db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id) as AppRecord | undefined;
  }

  getAppBySlug(slug: string): AppRecord | undefined {
    return this.db.prepare(`SELECT * FROM apps WHERE slug = ?`).get(slug) as AppRecord | undefined;
  }

  getAppByChannel(channelId: string): AppRecord | undefined {
    return this.db.prepare(`SELECT * FROM apps WHERE slack_channel_id = ?`).get(channelId) as
      | AppRecord
      | undefined;
  }

  listApps(): AppRecord[] {
    return this.db.prepare(`SELECT * FROM apps ORDER BY id DESC`).all() as AppRecord[];
  }

  createChange(
    c: Pick<ChangeRecord, "app_id" | "slack_thread_ts" | "requested_by" | "request" | "branch">,
  ): ChangeRecord {
    const info = this.db
      .prepare(
        `INSERT INTO changes (app_id, slack_thread_ts, requested_by, request, branch) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(c.app_id, c.slack_thread_ts, c.requested_by, c.request, c.branch);
    return this.getChange(Number(info.lastInsertRowid))!;
  }

  updateChange(id: number, patch: Partial<Omit<ChangeRecord, "id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE changes SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }

  getChange(id: number): ChangeRecord | undefined {
    return this.db.prepare(`SELECT * FROM changes WHERE id = ?`).get(id) as ChangeRecord | undefined;
  }

  /** 같은 Slack 스레드에서 아직 열려 있는 변경(= 같은 브랜치에 이어서 수정) */
  getOpenChangeByThread(appId: number, threadTs: string): ChangeRecord | undefined {
    return this.db
      .prepare(
        `SELECT * FROM changes WHERE app_id = ? AND slack_thread_ts = ? AND status IN ('running','preview','failed') ORDER BY id DESC LIMIT 1`,
      )
      .get(appId, threadTs) as ChangeRecord | undefined;
  }

  /** 앱과 그 작업 기록을 지운다 (/deleteapp). 같은 이름을 다시 쓸 수 있게 된다. */
  deleteApp(id: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM changes WHERE app_id = ?").run(id);
      this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
    })();
  }

  close(): void {
    this.db.close();
  }
}
