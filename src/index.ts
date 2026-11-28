import { loadConfig, reviewerEnabled } from "./config.js";
import { runCodexReview } from "./integrations/codex.js";
import { runCodingAgent } from "./integrations/agent.js";
import { ClaudeClient } from "./integrations/claude.js";
import { GitHub } from "./integrations/github.js";
import { Vercel } from "./integrations/vercel.js";
import { AppsInToss } from "./integrations/appsintoss.js";
import { TossConsole } from "./integrations/tossconsole.js";
import { createSlackApp } from "./slack/app.js";
import { Store } from "./store.js";
import { SerialQueue } from "./util/serial.js";

process.loadEnvFile?.(".env");
const config = loadConfig();

const app = createSlackApp(
  {
    config,
    store: new Store(config.DATA_DIR),
    claude: new ClaudeClient({
      model: config.CLAUDE_MODEL,
      runner: config.AGENT_RUNNER,
      apiKey: config.ANTHROPIC_API_KEY,
      claudeBin: config.CLAUDE_BIN,
    }),
    github: new GitHub(config.GITHUB_TOKEN, config.GITHUB_OWNER, config.GITHUB_PROJECT_TOKEN || undefined),
    vercel: new Vercel(config.VERCEL_TOKEN, config.VERCEL_TEAM_ID),
    queue: new SerialQueue(),
    runAgent: runCodingAgent,
    toss: new AppsInToss(config.APPS_IN_TOSS_API_KEY || undefined),
    tossConsole: new TossConsole({ enabled: config.TOSS_CONSOLE_MCP, model: config.CLAUDE_MODEL, claudeBin: config.CLAUDE_BIN }),
    runReview: reviewerEnabled(config) ? runCodexReview : undefined,
  },
  {
    botToken: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    launchChannel: config.SLACK_LAUNCH_CHANNEL,
    reviewer: reviewerEnabled(config)
      ? { botToken: config.REVIEWER_SLACK_BOT_TOKEN!, appToken: config.REVIEWER_SLACK_APP_TOKEN! }
      : undefined,
  },
);

await app.start();
console.log(
  `⚡ pipeline 봇이 Slack(Socket Mode)에 연결됐어요.${reviewerEnabled(config) ? " 리뷰어(Codex)도 켜졌어요." : ""}`,
);
