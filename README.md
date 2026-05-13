# AI Proxy

An OpenAI-compatible LLM proxy. Receives standard `/v1/*` requests and forwards
them to a configurable upstream — OpenAI, any OpenAI-compatible backend
(Ollama, vLLM, LM Studio, OpenRouter, Groq…), or **Google Gemini** with full
request/response translation.

Designed to plug into [n8n](https://n8n.io)'s AI Agent node (or any OpenAI
SDK) by pointing it at this proxy's base URL.

## Features

- OpenAI-compatible endpoints: `/v1/models`, `/v1/chat/completions`,
  `/v1/completions`, `/v1/embeddings`
- Streaming (SSE) supported, including for Gemini (chunks translated on the fly)
- **Gemini provider** — translates messages, system instructions, vision
  (`image_url`), generation params, usage, finish reasons, and SSE chunks
- Outbound **HTTP/HTTPS proxy** support via `HTTPS_PROXY` / `HTTP_PROXY` /
  `NO_PROXY` for corporate networks
- API-key auth on the proxy itself (separate from the upstream key)
- CORS for n8n's browser frontend
- **Live dashboard** at `/` showing uptime, totals, and recent requests with
  click-to-expand request/response bodies

## Quick start

```bash
npm install
cp .env.example .env       # then edit .env
npm start
```

Point any OpenAI client at the proxy:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3005/v1", api_key="<PROXY_API_KEY>")
```

## Configuration

See [`.env.example`](.env.example) for all options. Key variables:

| Var | Purpose |
|-----|---------|
| `PROXY_API_KEY` | Clients authenticate to the proxy with this |
| `UPSTREAM_BASE_URL` | Upstream LLM API base URL |
| `UPSTREAM_API_KEY` | Real key for the upstream |
| `UPSTREAM_PROVIDER` | `openai` (default, passthrough) or `gemini` (translated) |
| `LOCAL_MODELS` | JSON array of model IDs to return without hitting upstream (handy for n8n's dropdown) |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Outbound corporate proxy |
| `DASHBOARD_TOKEN` | Optional dashboard auth — open `/?token=...` |

## Using Gemini

```env
UPSTREAM_PROVIDER=gemini
UPSTREAM_API_KEY=AIza...           # https://aistudio.google.com/apikey
DEFAULT_MODEL=gemini-1.5-flash
```

Clients keep using the OpenAI protocol — the proxy translates both directions.

## Using n8n

1. n8n → Credentials → **OpenAI**
2. API Key → your `PROXY_API_KEY`
3. Base URL → `http://your-proxy-host:3005/v1`
4. In the AI Agent node, select the credential — the model dropdown is
   populated from `/v1/models`

## Dashboard

Open `http://localhost:3005/`. Shows uptime, request totals, byte counters,
errors, and a live table of recent requests. Click any row for the full
request body, response body, status, duration, and client IP.

## Docker

See [DOCKER.md](DOCKER.md) for build & deployment instructions
(`docker compose`, CLI, or helper scripts in `docker/`).

## License

MIT
