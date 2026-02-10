#!/bin/bash

# Configuration
SERVICE_NAME="com.user.do-ai-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
BUN_PATH="/Users/mahy/.bun/bin/bun"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_FILE="$SCRIPT_DIR/index.ts"
ENV_FILE="$SCRIPT_DIR/.env"

echo "Creating launchd service for Digital Ocean AI Proxy..."

# Create the plist file header
cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN_PATH</string>
        <string>run</string>
        <string>$SCRIPT_FILE</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.bun/bin</string>
EOF

# Append variables from .env to the plist
if [ -f "$ENV_FILE" ]; then
    echo "Reading .env file..."
    while IFS='=' read -r key value || [ -n "$key" ]; do
        # Skip comments and empty lines
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        
        # Trim whitespace
        key=$(echo "$key" | xargs)
        value=$(echo "$value" | xargs)

        # Remove quotes using sed (safer than parameter expansion in some contexts)
        value=$(echo "$value" | sed 's/^"//;s/"$//;s/^'\''//;s/'\''$//')

        echo "        <key>$key</key>" >> "$PLIST_PATH"
        echo "        <string>$value</string>" >> "$PLIST_PATH"
    done < "$ENV_FILE"
fi

# Create the plist file footer
cat <<EOF >> "$PLIST_PATH"
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/do-ai-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/do-ai-proxy.error.log</string>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
</dict>
</plist>
EOF

echo "✅ Created plist at $PLIST_PATH"

# Unload previous service if running
launchctl unload "$PLIST_PATH" 2>/dev/null

# Load and start the service
echo "Loading service..."
launchctl load "$PLIST_PATH"

# Wait a moment for service to start
sleep 2

# Check if service is running
if launchctl list | grep -q "$SERVICE_NAME"; then
    echo "✅ Digital Ocean AI Proxy Service loaded and started!"
    echo "📊 Service Status: RUNNING"
    echo "📝 Logs: ~/Library/Logs/do-ai-proxy.log"
    echo "📝 Errors: ~/Library/Logs/do-ai-proxy.error.log"
    echo ""
    echo "Test the proxy:"
    echo "  curl http://localhost:4005/"
    echo ""
    echo "View logs:"
    echo "  tail -f ~/Library/Logs/do-ai-proxy.log"
    echo ""
    echo "Stop service:"
    echo "  ./stop-do-proxy.sh"
else
    echo "❌ Service failed to start!"
    echo "Check error log: tail ~/Library/Logs/do-ai-proxy.error.log"
    echo "Check if port 4005 is already in use: lsof -i :4005"
    exit 1
fi