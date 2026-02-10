#!/bin/bash

echo "🔍 Digital Ocean AI Proxy - System Check"
echo "=========================================="
echo ""

# Check if .env exists
if [ -f ".env" ]; then
    echo "✅ .env file found"
    
    # Check if API key is set
    if grep -q "DO_API_KEY=your_actual_api_key_here" .env; then
        echo "⚠️  API key still set to placeholder - update .env with your real key"
    elif grep -q "DO_API_KEY=" .env; then
        echo "✅ API key configured"
    else
        echo "❌ DO_API_KEY not found in .env"
    fi
    
    # Check port setting
    PORT=$(grep "^PORT=" .env | cut -d'=' -f2 | tr -d ' ')
    if [ -n "$PORT" ]; then
        echo "✅ Port configured: $PORT"
    else
        echo "⚠️  PORT not set, will use default 4005"
        PORT=4005
    fi
else
    echo "❌ .env file not found - create it first!"
    echo "   cp .env.example .env  # or create manually"
    exit 1
fi

echo ""

# Check if Bun is installed
if command -v bun &> /dev/null; then
    BUN_VERSION=$(bun --version)
    echo "✅ Bun installed: v$BUN_VERSION"
else
    echo "❌ Bun not installed!"
    echo "   Install: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

echo ""

# Check if service is loaded
SERVICE_NAME="com.user.do-ai-proxy"
if launchctl list | grep -q "$SERVICE_NAME"; then
    echo "✅ Background service is loaded"
    
    # Check if actually running
    if lsof -i ":$PORT" &> /dev/null; then
        echo "✅ Proxy is running on port $PORT"
        
        # Test the endpoint
        echo ""
        echo "Testing proxy endpoint..."
        RESPONSE=$(curl -s -w "\n%{http_code}" http://localhost:$PORT/ 2>/dev/null)
        HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
        BODY=$(echo "$RESPONSE" | head -n-1)
        
        if [ "$HTTP_CODE" = "200" ]; then
            echo "✅ Proxy responding correctly"
            echo "   Response: $BODY"
        else
            echo "⚠️  Proxy returned HTTP $HTTP_CODE"
        fi
    else
        echo "⚠️  Service loaded but not listening on port $PORT"
        echo "   Check logs: tail ~/Library/Logs/do-ai-proxy.error.log"
    fi
else
    echo "ℹ️  Background service not loaded"
    echo "   Run: ./setup-do-proxy.sh"
    
    # Check if port is available
    if lsof -i ":$PORT" &> /dev/null; then
        echo "⚠️  Port $PORT is in use by another process:"
        lsof -i ":$PORT"
    fi
fi

echo ""
echo "📝 Log files:"
echo "   Standard: ~/Library/Logs/do-ai-proxy.log"
echo "   Errors: ~/Library/Logs/do-ai-proxy.error.log"
echo ""
echo "Done!"