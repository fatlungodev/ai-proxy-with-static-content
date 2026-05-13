#!/bin/bash
# Run the AI Proxy container using .env from the project root.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ ! -f .env ]; then
  echo "ERROR: .env not found in $PROJECT_ROOT — copy .env.example to .env first." >&2
  exit 1
fi

sudo docker run -d \
  --name ai-proxy \
  --restart always \
  -p 3005:3005 \
  --env-file .env \
  ai-proxy
