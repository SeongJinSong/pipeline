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
  /** 1 = /connectapp 으로 연결한 기존 레포 (봇이 만든 게 아니라 지우지 않는다) */
  connected: number;
  /** GitHub Project(v2) 보드 (만들지 못했으면 null) */
  project_id: string | null;
  project_url: string | null;
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
  /** 이 요청을 기록한 GitHub 이슈 (이슈를 못 만들었으면 null) */
  issue_number: number | null;
  preview_url: string | null;
  status: ChangeStatus;
  summary: string | null;
  cost_usd: number;
  /** 리뷰어가 이 변경을 리뷰한 횟수 (사람이 새로 요청하면 0 으로) */
  review_rounds: number;
  created_at: string;
}

/** 리뷰어(Codex)가 남긴 리뷰 한 건. 다음 라운드 리뷰어·파피 프롬프트에 넣어 맥락을 잇는다 */
export interface ReviewRecord {
  id: number;
  change_id: number;
  round: number;
  verdict: "approve" | "changes_requested";
  summary: string;
  findings_json: string;
  /** 리뷰 뒤 파피가 남긴 반영 요약 (반영 안 했으면 null) */
  fix_summary: string | null;
  head_sha: string;
  created_at: string;
}

/** /newapp 또는 @pipeline 아이디어로 시작한 PRD 스레드 */
export type DraftStatus = "drafting" | "launching" | "launched" | "cancelled";

export interface DraftRecord {
  id: number;
  channel_id: string;
  thread_ts: string;
  idea: string;
  spec_json: string;
  /** SpecTurn[] JSON: 스레드에서 오간 대화 (맥락 유지용) */
  history_json: string;
  status: DraftStatus;
  app_id: number | null;
  created_by: string;
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
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        idea TEXT NOT NULL,
        spec_json TEXT NOT NULL DEFAULT '{}',
        history_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'drafting',
        app_id INTEGER,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(channel_id, thread_ts)
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        change_id INTEGER NOT NULL REFERENCES changes(id),
        round INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        findings_json TEXT NOT NULL DEFAULT '[]',
        fix_summary TEXT,
        head_sha TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS reviews_change ON reviews(change_id);
    `);
    // 이전 버전 DB 마이그레이션
    const appCols = (this.db.prepare("PRAGMA table_info(apps)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!appCols.includes("connected")) this.db.exec("ALTER TABLE apps ADD COLUMN connected INTEGER NOT NULL DEFAULT 0");
    if (!appCols.includes("project_id")) this.db.exec("ALTER TABLE apps ADD COLUMN project_id TEXT");
    if (!appCols.includes("project_url")) this.db.exec("ALTER TABLE apps ADD COLUMN project_url TEXT");
    const changeCols = (this.db.prepare("PRAGMA table_info(changes)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!changeCols.includes("issue_number")) this.db.exec("ALTER TABLE changes ADD COLUMN issue_number INTEGER");
    if (!changeCols.includes("review_rounds")) {
      this.db.exec("ALTER TABLE changes ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0");
    }
  }

  createApp(
    a: Pick<AppRecord, "slug" | "name" | "idea" | "repo" | "created_by"> & { connected?: boolean },
  ): AppRecord {
    const info = this.db
      .prepare(`INSERT INTO apps (slug, name, idea, repo, created_by, connected) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(a.slug, a.name, a.idea, a.repo, a.created_by, a.connected ? 1 : 0);
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

  getAppByRepo(repo: string): AppRecord | undefined {
    return this.db.prepare(`SELECT * FROM apps WHERE lower(repo) = lower(?)`).get(repo) as AppRecord | undefined;
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

  addReview(r: Pick<ReviewRecord, "change_id" | "round" | "verdict" | "summary" | "findings_json" | "head_sha">): ReviewRecord {
    const info = this.db
      .prepare(
        `INSERT INTO reviews (change_id, round, verdict, summary, findings_json, head_sha) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.change_id, r.round, r.verdict, r.summary, r.findings_json, r.head_sha);
    return this.db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(Number(info.lastInsertRowid)) as ReviewRecord;
  }

  setReviewFix(reviewId: number, fixSummary: string): void {
    this.db.prepare(`UPDATE reviews SET fix_summary = ? WHERE id = ?`).run(fixSummary, reviewId);
  }

  listReviews(changeId: number): ReviewRecord[] {
    return this.db.prepare(`SELECT * FROM reviews WHERE change_id = ? ORDER BY id`).all(changeId) as ReviewRecord[];
  }

  createDraft(d: Pick<DraftRecord, "channel_id" | "thread_ts" | "idea" | "created_by">): DraftRecord {
    const info = this.db
      .prepare(`INSERT INTO drafts (channel_id, thread_ts, idea, created_by) VALUES (?, ?, ?, ?)`)
      .run(d.channel_id, d.thread_ts, d.idea, d.created_by);
    return this.getDraft(Number(info.lastInsertRowid))!;
  }

  updateDraft(id: number, patch: Partial<Omit<DraftRecord, "id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE drafts SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }

  getDraft(id: number): DraftRecord | undefined {
    return this.db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as DraftRecord | undefined;
  }

  getDraftByThread(channelId: string, threadTs: string): DraftRecord | undefined {
    return this.db.prepare(`SELECT * FROM drafts WHERE channel_id = ? AND thread_ts = ?`).get(channelId, threadTs) as
      | DraftRecord
      | undefined;
  }

  /** 앱과 그 작업 기록을 지운다 (/deleteapp). 같은 이름을 다시 쓸 수 있게 된다. */
  deleteApp(id: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM reviews WHERE change_id IN (SELECT id FROM changes WHERE app_id = ?)").run(id);
      this.db.prepare("DELETE FROM changes WHERE app_id = ?").run(id);
      this.db.prepare("UPDATE drafts SET app_id = NULL WHERE app_id = ?").run(id);
      this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
    })();
  }

  close(): void {
    this.db.close();
  }
}
