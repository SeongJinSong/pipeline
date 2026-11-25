import type { Config } from "../config.js";
import type { ClaudeClient } from "../integrations/claude.js";
import type { GitHub } from "../integrations/github.js";
import type { Vercel } from "../integrations/vercel.js";
import type { runCodingAgent } from "../integrations/agent.js";
import type { Store } from "../store.js";
import type { SerialQueue } from "../util/serial.js";

/** Slack 의존성을 흐름(flow) 코드에서 떼어내기 위한 최소 인터페이스 */
export interface Notifier {
  post(channel: string, text: string, opts?: { threadTs?: string; blocks?: unknown[] }): Promise<string>;
  update(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void>;
  createChannel(name: string, purpose: string): Promise<string>;
  invite(channel: string, userIds: string[]): Promise<void>;
  /** 채널 보관. 같은 이름을 다시 쓸 수 있게 먼저 이름을 바꾼다. */
  archiveChannel(channel: string): Promise<void>;
  /** 메시지 링크 */
  permalink?(channel: string, ts: string): Promise<string | undefined>;
}

export interface Deps {
  config: Config;
  store: Store;
  claude: ClaudeClient;
  github: GitHub;
  vercel: Vercel;
  notifier: Notifier;
  queue: SerialQueue;
  runAgent: typeof runCodingAgent;
}
