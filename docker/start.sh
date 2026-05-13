#!/bin/bash
sudo docker run -d \
  --name ai-proxy \
  --restart always \
  -p 3000:3000 \
  --env-file .env \
  ai-proxy
