# OpenClaw Agent — Docker Template

A self-hosted [OpenClaw](https://openclaw.ai) agent setup with persistent config, Telegram support, and an MCP bridge for connecting external tools. Designed to be cloned and spun up as many times as you need — one instance per agent, each fully independent.

---

## What's included

| File | Purpose |
|---|---|
| `init-openclaw.js` | Generates OpenClaw config, skills, and MCP bridge on first boot. Skips files that already exist on restart. |
| `docker-compose.yml` | Full template with every supported environment variable documented. |
| `Dockerfile` | Base image for the agent container. |

---

## Quick start

### 1. Clone the repo

```sh
git clone https://github.com/you/openclaw-agent
cd openclaw-agent
```

### 2. Copy and fill in your env vars

Open `docker-compose.yml` and fill in at minimum:

```yaml
- LLM_MODEL=your-model-name
- OPENAI_API_BASE=http://your-llm-host:port
- OPENAI_API_KEY=your-key
- OPENCLAW_GATEWAY_TOKEN=your-token   # openssl rand -hex 32
- BRAVE_API_KEY=your-brave-key
```

### 3. Start it

```sh
docker compose up -d
```

The gateway UI will be available at `http://localhost:5000`.

---

## Telegram setup

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram and copy the token
2. Set `TELEGRAM_BOT_TOKEN=your-token` in `docker-compose.yml`
3. Start (or restart) the container
4. DM your bot on Telegram — it will reply with a pairing code
5. Approve yourself:

```sh
docker exec -it openclaw-agent openclaw pairing approve telegram <code>
```

That's it. Only approved users get responses. Nobody else can get past the pairing step unless you run that command for them.

### Telegram DM policies

| Policy | Behaviour |
|---|---|
| `pairing` | *(default)* User sends `/start`, you approve manually with the command above |
| `allowlist` | Only Telegram user IDs listed in `TELEGRAM_ALLOW_FROM` can DM the bot |
| `open` | Anyone can DM immediately — not recommended for personal bots |

> To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot).

---

## Config persistence

All config lives in `./data` (mounted into the container at `/home/node/.openclaw`). On every restart, `init-openclaw.js` checks whether each file exists before writing — so your config and any manual edits are always preserved.

### Resetting config

| What | Command |
|---|---|
| Full reset (regenerate everything) | `docker compose down && rm -rf ./data && docker compose up` |
| Regenerate only `openclaw.json` (e.g. after changing model or adding Telegram) | `rm ./data/openclaw.json && docker compose restart` |
| Regenerate a skill | `rm ./data/skills/router.md && docker compose restart` |

---

## Running multiple instances

Each instance needs its own `container_name`, port mapping, and data directory. Duplicate the service block in `docker-compose.yml`:

```yaml
services:

  openclaw-agent-alice:
    container_name: openclaw-agent-alice
    ports:
      - "5000:3000"
      - "3001:3001"
    volumes:
      - ./data-alice:/home/node/.openclaw
    environment:
      - TELEGRAM_BOT_TOKEN=token-for-alice-bot
      # ...

  openclaw-agent-bob:
    container_name: openclaw-agent-bob
    ports:
      - "5001:3000"
      - "3002:3001"
    volumes:
      - ./data-bob:/home/node/.openclaw
    environment:
      - TELEGRAM_BOT_TOKEN=token-for-bob-bot
      # ...
```

Each instance has its own isolated config, workspace, and Telegram bot.

---

## Environment variable reference

### Core

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_MODEL` | ✅ | `qwen3.5:35b` | Model ID as your provider knows it |
| `OPENAI_API_BASE` | ✅ | — | Base URL of your OpenAI-compatible LLM provider |
| `OPENAI_API_KEY` | ✅ | — | API key for your LLM provider |
| `OPENCLAW_GATEWAY_TOKEN` | ✅ | — | Auth token for the gateway (`openssl rand -hex 32`) |
| `OPENCLAW_TRUSTED_PROXIES` | — | `127.0.0.1` | Comma-separated IPs of trusted reverse proxies |
| `BRAVE_API_KEY` | — | — | [Brave Search API](https://brave.com/search/api/) key for web search |

### Telegram

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | — | Bot token from @BotFather. Leave empty to disable Telegram. |
| `TELEGRAM_DM_POLICY` | — | `pairing` | `pairing`, `allowlist`, or `open` |
| `TELEGRAM_ALLOW_FROM` | — | — | Comma-separated user IDs, only used when policy is `allowlist` |

### MCP Bridge

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_PORT` | — | `3001` | Port the MCP HTTP proxy listens on |
| `AGENT_TIMEOUT_MS` | — | `120000` | How long (ms) to wait for the agent to respond via MCP tools |
| `OPENCLAW_BASE_URL` | — | `http://localhost:3000` | Internal URL the MCP bridge uses to reach the gateway |

### MCP Server extras

Add any env vars your MCP servers need alongside the above. Common ones:

```yaml
- GITHUB_TOKEN=
- NOTION_API_KEY=
- LINEAR_API_KEY=
- SLACK_BOT_TOKEN=
- SLACK_APP_TOKEN=
- GOOGLE_CLIENT_ID=
- GOOGLE_CLIENT_SECRET=
- GOOGLE_REFRESH_TOKEN=
- POSTGRES_CONNECTION_STRING=
- REDIS_URL=
- AWS_ACCESS_KEY_ID=
- AWS_SECRET_ACCESS_KEY=
- AWS_REGION=
```

---

## Ports

| Port (host) | Port (container) | What |
|---|---|---|
| `5000` | `3000` | OpenClaw gateway UI and API |
| `3001` | `3001` | MCP proxy endpoint (for Open WebUI, etc.) |

Both are configurable — just change the left side of the mapping in `docker-compose.yml`.

---

## Connecting Open WebUI (or any OpenAI-compatible client)

Point your client at the MCP bridge's `/v1` endpoint:

```
Base URL: http://<your-host>:3001/v1
API Key:  (leave blank or use any value)
```

The bridge injects your OpenClaw context files and proxies requests through to the gateway automatically.