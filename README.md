# Digital Ocean AI Proxy for Continue

This project provides a lightweight, local proxy server that enables you to use Digital Ocean's GenAI platform (specifically Anthropic Claude models) with AI coding assistants like **Continue** (VS Code / JetBrains) or **Cursor**.

It bridges the gap between tools expecting OpenAI-compatible API endpoints and Digital Ocean's specific inference API.

## Quick Start (TL;DR)

```bash
# 1. Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# 2. Clone and setup
git clone https://github.com/your-username/digital-ocean-ai-proxy.git
cd digital-ocean-ai-proxy
bun install

# 3. Create .env with your Digital Ocean API key
cat > .env << EOF
DO_INFERENCE_URL=https://inference.do-ai.run
DO_API_KEY=your_actual_api_key_here
PORT=4005
EOF

# 4. Start as background service
chmod +x setup-do-proxy.sh
./setup-do-proxy.sh

# 5. Test it works
curl http://localhost:4005/
```

Then configure Continue/Cursor to use `http://localhost:4005/v1` as the API base URL.

## Features

- 🚀 **Fast & Lightweight**: Built with [Bun](https://bun.sh), a modern JavaScript runtime.
- 🔄 **OpenAI Compatibility**: Proxies `/v1/chat/completions` and `/v1/models` to Digital Ocean.
- 🔑 **Secure**: Runs locally on your machine; your API key stays on your system.
- ⚙️ **Configurable**: Easy setup via `.env` file.
- 🖥️ **Background Service**: Includes a script to run as a persistent macOS background service.
- 🔄 **Auto-restart**: Service automatically restarts on system reboot.
- ⚡ **Smart Retries**: Automatic retry logic for rate limits and transient errors.

## Prerequisites

- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`).
- A Digital Ocean account with access to the **GenAI Platform**.
- macOS (for background service feature - manual run works on any platform)

## Setup Guide

### 1. Get Your Digital Ocean API Key

1.  Log in to your [Digital Ocean Cloud Console](https://cloud.digitalocean.com).
2.  Navigate to **GenAI Platform** -> **Agents** (or **Inference** depending on your access).
3.  Create a new **Agent Key** or **API Token** with scope for inference.
4.  Copy the key (it usually starts with `do_genai_...` or similar).

### 2. Install & Configure Proxy

Clone this repository and navigate to the folder:

```bash
git clone https://github.com/your-username/digital-ocean-ai-proxy.git
cd digital-ocean-ai-proxy
```

Install dependencies:

```bash
bun install
```

Create a `.env` file from the example (or just create one):

```bash
touch .env
```

Add your configuration to `.env`:

```env
# Your Digital Ocean GenAI Endpoint
DO_INFERENCE_URL=https://inference.do-ai.run

# Your Digital Ocean API Key
DO_API_KEY=your_actual_api_key_here

# Local Port for the Proxy
PORT=4005
```

### 3. Run the Proxy

**Option A: Run Temporarily (for testing)**

To test the proxy manually before setting it up as a service:

```bash
bun start
```

This will run the proxy in your current terminal. Press `Ctrl+C` to stop it.

**Option B: Run as a Persistent Background Service (macOS) - RECOMMENDED**

The proxy can run automatically in the background, even after reboots. This is the recommended setup for daily use:

1. Make the setup script executable:
   ```bash
   chmod +x setup-do-proxy.sh
   ```

2. Run the setup script:
   ```bash
   ./setup-do-proxy.sh
   ```

3. The script will:
   - Create a macOS LaunchAgent configuration
   - Start the proxy service immediately  
   - Configure it to auto-start on login/reboot
   - Verify the service is running
   
   **Important**: Once setup is complete, the proxy will **automatically start** every time you log in or reboot your Mac. You don't need to run `bun start` or any other command - it's always running in the background!

4. Test that it's working:
   ```bash
   curl http://localhost:4005/
   ```
   You should see: `{"status":"running","target":"https://inference.do-ai.run"}`

**Quick Health Check:**

Run the included check script to verify everything is configured correctly:

```bash
chmod +x check-proxy.sh
./check-proxy.sh
```

This will verify:
- ✅ .env file exists and is configured
- ✅ Bun is installed
- ✅ Service is loaded and running
- ✅ Proxy is responding to requests
- ✅ Port is not blocked

**Managing the Background Service:**

- **View logs**: `tail -f ~/Library/Logs/do-ai-proxy.log`
- **View errors**: `tail -f ~/Library/Logs/do-ai-proxy.error.log`
- **Stop service**: `./stop-do-proxy.sh` or `launchctl unload ~/Library/LaunchAgents/com.user.do-ai-proxy.plist`
- **Restart service**: `./setup-do-proxy.sh` (it will unload and reload automatically)
- **Check status**: `launchctl list | grep do-ai-proxy`

## Configure "Continue" Extension

This proxy allows you to use Claude 3.5 Sonnet and Haiku via Digital Ocean in the [Continue](https://continue.dev/) extension for VS Code or JetBrains.

1.  Install the **Continue** extension.
2.  Open the Continue configuration file (`config.yaml`).
    -   Click the gear icon ⚙️ in the Continue sidebar.
3.  Replace the `models` section with the following configuration:

```yaml
name: Digital Ocean AI Config
version: 1.0.0
schema: v1
models:
  - name: DO Claude 3.5 Sonnet
    provider: openai
    model: anthropic-claude-4.5-sonnet
    apiBase: http://localhost:4005/v1
    apiKey: anything
    roles:
      - chat
      - edit
      - apply

  - name: DO Claude 3.5 Haiku
    provider: openai
    model: anthropic-claude-haiku-4.5
    apiBase: http://localhost:4005/v1
    apiKey: anything
    roles:
      - chat
      - edit
      - apply

  - name: DO Claude 4.6 Opus
    provider: openai
    model: anthropic-claude-opus-4.6
    apiBase: http://localhost:4005/v1
    apiKey: anything
    roles:
      - chat
      - edit
      - apply

  - name: DO GPT-5.1 Codex Max
    provider: openai
    model: openai-gpt-5.1-codex-max
    apiBase: http://localhost:4005/v1
    apiKey: anything
    roles:
      - chat
      - edit
      - apply

  - name: DO GPT-5 Mini
    provider: openai
    model: openai-gpt-5-mini
    apiBase: http://localhost:4005/v1
    apiKey: anything
    roles:
      - chat
      - edit
      - apply

  - name: DO GPT-5.2
    provider: openai
    model: openai-gpt-5.2
    apiBase: http://localhost:4005/v1
    apiKey: anything
    roles:
      - chat
      - edit
      - apply

  - name: DO GPT-5.2 Pro
    provider: openai
    model: openai-gpt-5.2-pro
    apiBase: http://localhost:4005/v1
    apiKey: anything
    roles:
      - chat
      - edit
      - apply

  - name: DO GPT OSS 120B
    provider: openai
    model: openai-gpt-oss-120b
    apiBase: http://localhost:4005/v1
    apiKey: anything
    roles:
      - chat
      - edit
      - apply
```

4.  Save the file. Continue should now be able to chat using your Digital Ocean models!

## Configure Cursor (Alternative)

If you use [Cursor](https://cursor.sh):

1.  Go to **Settings** > **Models**.
2.  Enable "OpenAI API Key".
3.  Set **Base URL** to: `http://localhost:4005/v1`.
4.  Set **API Key** to: `dummy` (or anything).
5.  Add a custom model named: `anthropic-claude-4.5-sonnet`.
6.  Select it and start coding!

## Troubleshooting

### Service Not Starting

1. **Check if service is loaded**:
   ```bash
   launchctl list | grep do-ai-proxy
   ```
   If you see it listed, the service is loaded (but may not be running).

2. **Check error logs**:
   ```bash
   tail -50 ~/Library/Logs/do-ai-proxy.error.log
   ```

3. **Check standard logs**:
   ```bash
   tail -50 ~/Library/Logs/do-ai-proxy.log
   ```

4. **Verify port is not in use**:
   ```bash
   lsof -i :4005
   ```
   If another process is using port 4005, either stop it or change the PORT in `.env`.

5. **Verify Bun path**:
   ```bash
   which bun
   ```
   If the path is different from `/Users/mahy/.bun/bin/bun`, edit `setup-do-proxy.sh` and update the `BUN_PATH` variable.

6. **Test manually first**:
   ```bash
   bun start
   ```
   If this fails, fix the error before setting up the service.

### API Issues

- **Invalid API Key**: Double-check your Digital Ocean API key in `.env`.
- **Model Not Found**: Ensure the model name matches Digital Ocean's available models.
- **Rate Limiting**: The proxy automatically retries 429 errors with exponential backoff.

### Common Fixes

**Completely reset the service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.user.do-ai-proxy.plist
rm ~/Library/LaunchAgents/com.user.do-ai-proxy.plist
./setup-do-proxy.sh
```

**Change the port**:
1. Edit `.env` and change `PORT=4005` to a different port (e.g., `PORT=4006`)
2. Re-run: `./setup-do-proxy.sh`
3. Update your Continue/Cursor config to use the new port
