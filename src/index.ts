import { loadConfig } from "./config.js";
import { runCodingAgent } from "./integrations/agent.js";
import { ClaudeClient } from "./integrations/claude.js";
import { GitHub } from "./integrations/github.js";
import { Vercel } from "./integrations/vercel.js";
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
  },
  {
    botToken: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    launchChannel: config.SLACK_LAUNCH_CHANNEL,
  },
);

await app.start();
console.log("⚡ pipeline 봇이 Slack(Socket Mode)에 연결됐어요.");
