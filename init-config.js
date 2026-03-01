const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || "/home/node";
const CONFIG_DIR = path.join(HOME, ".openclaw");
const SKILLS_DIR = path.join(CONFIG_DIR, "skills");
const WORKSPACE_DIR = path.join(CONFIG_DIR, "workspace");

// Ensure directories exist (always safe to run)
fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

// Helper: only write a file if it doesn't already exist.
// This means container restarts won't overwrite manual edits or existing state.
// To force a reset, delete the file and restart the container.
function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    console.log(`[init] Skipping (already exists): ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, content);
  console.log(`[init] Created: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Model + auth
// ---------------------------------------------------------------------------

const GENERAL_MODEL = process.env.LLM_MODEL || "qwen3.5:35b";
const generalFullId = `openai/${GENERAL_MODEL}`;
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

// ---------------------------------------------------------------------------
// Telegram channel (only included if TELEGRAM_BOT_TOKEN is set)
// ---------------------------------------------------------------------------

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramDmPolicy = process.env.TELEGRAM_DM_POLICY || "pairing";
const telegramAllowFrom = (process.env.TELEGRAM_ALLOW_FROM || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean)
  .map(Number);

const telegramChannel = telegramBotToken
  ? {
      enabled: true,
      botToken: telegramBotToken,
      dmPolicy: telegramDmPolicy,
      ...(telegramAllowFrom.length > 0 && { allowFrom: telegramAllowFrom })
    }
  : null;

// ---------------------------------------------------------------------------
// Main config
// ---------------------------------------------------------------------------

const mainConfig = {
  gateway: {
    mode: "local",
    bind: "lan",
    port: 3000,
    controlUi: {
      enabled: true,
      allowInsecureAuth: true,
      dangerouslyDisableDeviceAuth: true,
      dangerouslyAllowHostHeaderOriginFallback: true
    },
    trustedProxies: (process.env.OPENCLAW_TRUSTED_PROXIES || "127.0.0.1").split(","),
    auth: { mode: "token", token: gatewayToken }
  },
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
        apiKey: process.env.BRAVE_API_KEY,
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15
      },
      fetch: { enabled: true }
    }
  },
  models: {
    mode: "replace",
    providers: {
      openai: {
        baseUrl: process.env.OPENAI_API_BASE,
        apiKey: process.env.OPENAI_API_KEY,
        api: "openai-completions",
        models: [
          { id: GENERAL_MODEL, name: "General Agent", contextWindow: 32768, maxTokens: 8192 }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: generalFullId },
      workspace: "~/.openclaw/workspace"
    },
    list: [
      {
        id: "main",
        name: "OpenClaw Assistant",
        model: { primary: generalFullId },
        skills: ["router"]
      }
    ]
  },
  channels: {
    ...(telegramChannel && { telegram: telegramChannel })
  },
  commands: { native: "auto", nativeSkills: "auto" }
};

writeIfMissing(
  path.join(CONFIG_DIR, "openclaw.json"),
  JSON.stringify(mainConfig, null, 2)
);

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

writeIfMissing(path.join(SKILLS_DIR, "router.md"), `# Router

Before responding to every user message, silently classify the task.

If the task is primarily coding — writing, debugging, refactoring, or explaining code in detail — handle it yourself with full focus on producing complete, working code.

Handle everything else yourself: questions, research, planning, agentic tasks, casual conversation, web lookups, file work.

Always produce a response. Never leave a message unanswered.
If a task is mixed, handle it fully in one response.
`);

// ---------------------------------------------------------------------------
// MCP bridge
// ---------------------------------------------------------------------------

const mcpBridge = `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import http from "http";

const execAsync = promisify(exec);

const WORKSPACE_DIR = "${WORKSPACE_DIR}";
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE || "${CONFIG_DIR}";
const MCP_PORT = parseInt(process.env.MCP_PORT || "3002");
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const OPENCLAW_BASE = process.env.OPENCLAW_BASE_URL || "http://localhost:3000";
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || "120000");

/** Reads all .md files from the OpenClaw root, same as the native UI injects */
function loadContextFiles() {
  if (!existsSync(OPENCLAW_WORKSPACE)) return "";
  const files = readdirSync(OPENCLAW_WORKSPACE).filter(f => f.endsWith(".md")).sort();
  if (!files.length) return "";
  return files.map(file => {
    const content = readFileSync(join(OPENCLAW_WORKSPACE, file), "utf8");
    return \`## \${file}\\n\${content.trim()}\`;
  }).join("\\n\\n");
}

/** Wraps a promise with a timeout, resolves with fallback message instead of rejecting */
function withTimeout(promise, ms, fallback) {
  const timer = new Promise(resolve => setTimeout(() => resolve(fallback), ms));
  return Promise.race([promise, timer]);
}

const TOOLS = [
  {
    name: "exec",
    description: "Run a shell command on the local machine",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
  },
  {
    name: "write_file",
    description: "Write content to a file in the workspace",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  },
  {
    name: "read_file",
    description: "Read a file from the workspace",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  },
  {
    name: "ls",
    description: "List files in a workspace directory",
    inputSchema: { type: "object", properties: { path: { type: "string", default: "." } } }
  },
  {
    name: "web_search",
    description: "Search the web via the OpenClaw agent",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  },
  {
    name: "ask_agent",
    description: "Send a message to the main OpenClaw agent. Use for complex or agentic tasks that need the full agent.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"]
    }
  }
];

async function callAgent(message) {
  const env = { ...process.env, PATH: \`\${process.env.PATH}:\${WORKSPACE_DIR}/bin\` };

  const httpCall = async () => {
    const response = await fetch(\`\${OPENCLAW_BASE}/api/agents/main/message\`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(OPENCLAW_TOKEN ? { Authorization: \`Bearer \${OPENCLAW_TOKEN}\` } : {})
      },
      body: JSON.stringify({ agentId: "main", message })
    });
    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
    const result = await response.json();
    return result.payloads?.map(p => p.text).join("\\n") || result.response || JSON.stringify(result);
  };

  const cliCall = async () => {
    const { stdout } = await execAsync(
      \`openclaw agent --agent main --message \${JSON.stringify(message)} --json\`,
      { env, timeout: AGENT_TIMEOUT_MS }
    );
    const result = JSON.parse(stdout);
    return result.payloads?.map(p => p.text).join("\\n") || stdout;
  };

  try {
    return await withTimeout(httpCall(), AGENT_TIMEOUT_MS, null);
  } catch {
    try {
      return await withTimeout(cliCall(), AGENT_TIMEOUT_MS, null);
    } catch {
      return null;
    }
  }
}

async function handleTool(name, args) {
  const env = { ...process.env, PATH: \`\${process.env.PATH}:\${WORKSPACE_DIR}/bin\` };

  if (name === "exec") {
    try {
      const { stdout, stderr } = await execAsync(args.command, { env, cwd: WORKSPACE_DIR, timeout: 60000 });
      return { content: [{ type: "text", text: \`STDOUT:\\n\${stdout}\\nSTDERR:\\n\${stderr}\` }] };
    } catch (e) {
      return { content: [{ type: "text", text: \`exec failed: \${e.message}\` }] };
    }
  }

  if (name === "write_file") {
    try {
      const fullPath = join(WORKSPACE_DIR, args.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, args.content);
      return { content: [{ type: "text", text: \`Written: \${args.path}\` }] };
    } catch (e) {
      return { content: [{ type: "text", text: \`write_file failed: \${e.message}\` }] };
    }
  }

  if (name === "read_file") {
    const fullPath = join(WORKSPACE_DIR, args.path);
    if (!existsSync(fullPath)) return { content: [{ type: "text", text: \`Not found: \${args.path}\` }] };
    return { content: [{ type: "text", text: readFileSync(fullPath, "utf8") }] };
  }

  if (name === "ls") {
    try {
      const files = readdirSync(join(WORKSPACE_DIR, args.path || "."));
      return { content: [{ type: "text", text: files.join("\\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: \`ls failed: \${e.message}\` }] };
    }
  }

  if (name === "web_search") {
    const result = await withTimeout(
      callAgent(\`Search the web for: \${args.query}\`),
      AGENT_TIMEOUT_MS,
      null
    );
    return { content: [{ type: "text", text: result || \`Search timed out. Query was: \${args.query}\` }] };
  }

  if (name === "ask_agent") {
    const result = await withTimeout(
      callAgent(args.message),
      AGENT_TIMEOUT_MS,
      null
    );
    return { content: [{ type: "text", text: result || \`Agent did not respond in time. Try again or rephrase.\` }] };
  }

  return { content: [{ type: "text", text: \`Unknown tool: \${name}\` }] };
}

const mcpServer = new Server({ name: "openclaw-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => handleTool(req.params.name, req.params.arguments));
const stdioTransport = new StdioServerTransport();
await mcpServer.connect(stdioTransport);

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const context = loadContextFiles();

        if (context) {
          const sysIdx = payload.messages?.findIndex(m => m.role === "system") ?? -1;
          if (sysIdx === -1) {
            payload.messages = [{ role: "system", content: context }, ...(payload.messages || [])];
          } else {
            payload.messages[sysIdx].content = context + "\\n\\n" + payload.messages[sysIdx].content;
          }
        }

        const upstream = await fetch(\`\${OPENCLAW_BASE}/v1/chat/completions\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(OPENCLAW_TOKEN ? { Authorization: \`Bearer \${OPENCLAW_TOKEN}\` } : {})
          },
          body: JSON.stringify(payload)
        });

        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
        const reader = upstream.body.getReader();
        const pump = async () => {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(value);
          await pump();
        };
        await pump();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(MCP_PORT, "0.0.0.0", () => {
  process.stderr.write(\`OpenWebUI proxy on port \${MCP_PORT} — connect to http://<your-ip>:\${MCP_PORT}/v1\\n\`);
});
`;

writeIfMissing(path.join(WORKSPACE_DIR, "mcp-bridge.js"), mcpBridge);

writeIfMissing(path.join(WORKSPACE_DIR, "package.json"), JSON.stringify({
  name: "openclaw-mcp-bridge",
  type: "module",
  dependencies: {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "mcp-proxy": "^6.4.0"
  }
}, null, 2));