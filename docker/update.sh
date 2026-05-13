#!/bin/bash
# Build the AI Proxy image from the project root regardless of CWD.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
sudo docker build --no-cache -t ai-proxy -f docker/Dockerfile .
