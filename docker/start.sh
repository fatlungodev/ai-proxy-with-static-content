#!/bin/bash
sudo docker run -d \
  --name ai-proxy \
  --restart always \
  -p 3005:3005 \
  --env-file .env \
  ai-proxy
