#!/bin/bash

SERVICE_NAME="com.user.do-ai-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"

echo "Stopping Digital Ocean AI Proxy..."

# Unload the service
launchctl unload "$PLIST_PATH"

echo "✅ Proxy Service stopped and removed from launchd!"
echo "You can view logs at ~/Library/Logs/do-ai-proxy.log"
