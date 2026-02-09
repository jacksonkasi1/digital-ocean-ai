# Digital Ocean AI Proxy for Continue

This project provides a lightweight, local proxy server that enables you to use Digital Ocean's GenAI platform (specifically Anthropic Claude models) with AI coding assistants like **Continue** (VS Code / JetBrains) or **Cursor**.

It bridges the gap between tools expecting OpenAI-compatible API endpoints and Digital Ocean's specific inference API.

## Features

- 🚀 **Fast & Lightweight**: Built with [Bun](https://bun.sh), a modern JavaScript runtime.
- 🔄 **OpenAI Compatibility**: Proxies `/v1/chat/completions` and `/v1/models` to Digital Ocean.
- 🔑 **Secure**: Runs locally on your machine; your API key stays on your system.
- ⚙️ **Configurable**: Easy setup via `.env` file.
- 🖥️ **Background Service**: Includes a script to run as a persistent macOS background service.

## Prerequisites

- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`).
- A Digital Ocean account with access to the **GenAI Platform**.

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

```bash
bun start
```

**Option B: Run as a Background Service (macOS)**

Use the included setup script to keep the proxy running in the background, even after restarts:

```bash
chmod +x setup-do-proxy.sh
./setup-do-proxy.sh
```

To stop the service later:
```bash
./stop-do-proxy.sh
```

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
    model: anthropic-claude-sonnet-4.5
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
```

4.  Save the file. Continue should now be able to chat using your Digital Ocean models!

## Configure Cursor (Alternative)

If you use [Cursor](https://cursor.sh):

1.  Go to **Settings** > **Models**.
2.  Enable "OpenAI API Key".
3.  Set **Base URL** to: `http://localhost:4005/v1`.
4.  Set **API Key** to: `dummy` (or anything).
5.  Add a custom model named: `anthropic-claude-sonnet-4.5`.
6.  Select it and start coding!

## Troubleshooting

- **Check Logs**: If running as a service, check logs at `~/Library/Logs/do-ai-proxy.log`.
- **Verify Port**: Ensure port `4005` is not used by another application.
- **API Key**: Double-check your Digital Ocean API key in `.env`.