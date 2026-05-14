# Docker Deployment Guide

Deploy the **AI Proxy** using Docker for a consistent and isolated environment.

> [!NOTE]
> All commands below should be executed from the **root directory** of the project.

## 📋 Prerequisites

- Docker installed on your system.
- Docker Compose (optional, but recommended).

## 🚀 Deployment Options

> [!IMPORTANT]
> The Docker image clones its application source from `https://github.com/fatlungodev/ai-proxy-with-static-content.git` during build. Local code changes in this workspace are not included unless you change the Dockerfile back or point it at a different repo (via the `APP_REPO_URL` build arg).

### Option 1: Using Shell Scripts

Quick scripts provided for building, starting, and stopping. The scripts
auto-anchor to the project root, so you can invoke them from anywhere.

1.  **Prepare the environment** (in project root):
    ```bash
    cp .env.example .env
    # edit .env — set PROXY_API_KEY, UPSTREAM_API_KEY, UPSTREAM_PROVIDER, etc.
    ```

2.  **Build**:
    ```bash
    sh docker/update.sh
    ```

3.  **Start**:
    ```bash
    sh docker/start.sh
    ```

4.  **Stop & Remove**:
    ```bash
    sh docker/stop.sh
    ```

---

### Option 2: Using Docker Compose (Recommended)

1.  **Prepare the environment**:
    ```bash
    cp .env.example .env
    # edit .env
    ```

2.  **Launch the container**:
    ```bash
    docker compose -f docker/docker-compose.yml up -d
    ```

3.  **Stop the container**:
    ```bash
    docker compose -f docker/docker-compose.yml down
    ```

---

### Option 3: Using Docker CLI

1.  **Build the image**:
    ```bash
    docker build -t ai-proxy -f docker/Dockerfile .
    ```

2.  **Prepare the environment**:
    ```bash
    cp .env.example .env
    # edit .env
    ```

3.  **Run the container**:
    > [!IMPORTANT]
    > You must provide the `.env` file at runtime since it's not baked into the image for security.

    ```bash
    mkdir -p data
    docker run -d \
      --name ai-proxy \
      -p 3005:3005 \
      --env-file .env \
      -v "$(pwd)/data":/app/data \
      ai-proxy
    ```

## ⚙️ Build Args

| Arg | Default | Description |
|-----|---------|-------------|
| `APP_REPO_URL` | `https://github.com/fatlungodev/ai-proxy-with-static-content.git` | Override to build from a fork or branch (use `#branch` suffix) |

Example — build from a fork:

```bash
docker build \
  --build-arg APP_REPO_URL=https://github.com/your-user/your-fork.git \
  -t ai-proxy -f docker/Dockerfile .
```

## 💾 Persistent Data

The container mounts `./data` (relative to the project root) to `/app/data` inside the container. This directory holds:

| File | Purpose |
|------|---------|
| `rules.json` | Static reply rules managed via the dashboard |
| `requests.log.jsonl` | One JSON object per request (auth, trace, request/response bodies) |
| `app-events.log.jsonl` | Application lifecycle events (rule changes, startup, errors) |

The two `.jsonl` files rotate at **100 MB** by default to `*.jsonl.1`. Override with `LOG_FILE_MAX_BYTES` in `.env` if you need a different cap.

On startup the proxy re-hydrates the in-memory ring buffer with the most recent `LOG_BUFFER_SIZE` requests (default 500) and `200` app events from these files, so dashboard history survives container restarts and rebuilds.

To back up: copy the entire `data/` folder. To start clean: stop the container, delete `data/`, restart.

## 🔍 Monitoring & Maintenance

- **View Logs**: `docker logs -f ai-proxy`
- **Stop Container**: `docker stop ai-proxy`
- **Check Status**: `docker compose -f docker/docker-compose.yml ps`
- **Dashboard**: open `http://<host>:3005/` in a browser
- **Health Check**: `curl http://localhost:3005/health`
