#!/bin/bash

SERVICE_NAME="com.user.do-ai-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"

echo "Stopping Digital Ocean AI Proxy..."

# Check if service is loaded
if launchctl list | grep -q "$SERVICE_NAME"; then
    # Unload the service
    launchctl unload "$PLIST_PATH"
    
    # Wait a moment
    sleep 1
    
    # Verify it stopped
    if ! launchctl list | grep -q "$SERVICE_NAME"; then
        echo "✅ Proxy Service stopped successfully!"
        echo "📝 Logs preserved at: ~/Library/Logs/do-ai-proxy.log"
        echo ""
        echo "To restart: ./setup-do-proxy.sh"
    else
        echo "⚠️  Service may still be running. Try:"
        echo "  launchctl remove $SERVICE_NAME"
    fi
else
    echo "ℹ️  Service is not currently loaded."
    echo "Nothing to stop."
fi
