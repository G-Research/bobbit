# Bobbit Agent Sandbox Image

Minimal Docker image for running Bobbit agent sessions in a sandboxed environment. When sandbox mode is enabled in Bobbit, agent processes run inside this container with restricted filesystem, network, and credential access.

## Build

```bash
docker build -t bobbit-agent docker/
```

The default image name `bobbit-agent` matches Bobbit's default `sandbox_image` config. To use a different name, update `sandbox_image` in your project settings.

## What's Included

- **Node.js 20** (slim base) — runtime for the agent process
- **git** — version control operations
- **curl** — HTTP requests
- **gh CLI** — GitHub CLI for PR creation, issue management, etc.
- **build-essential** — gcc, g++, make for native Node.js module compilation
- **python3** — required by some native module build systems (e.g. node-gyp)

## Design

The agent CLI (`@mariozechner/pi-coding-agent`) is **not** installed in the image. It is bind-mounted from the host at runtime:

```
-v <hostNodeModules>:/agent-modules:ro
```

This ensures:
- The container always uses the **same agent version** as the gateway
- The image stays lightweight and doesn't need rebuilding on agent updates
- No version drift between sandboxed and non-sandboxed sessions

Bobbit handles all mount and environment configuration automatically when launching sandboxed sessions.

## Security

- **Non-root execution**: Runs as the `node` user (uid=1000), not root. Files created in the bind-mounted workspace are owned by uid=1000 on the host, matching typical developer user IDs. A container escape does not grant host root access.
- **No Docker socket**: The Docker socket (`/var/run/docker.sock`) is never mounted. The container cannot control Docker or escape to the host.
- **Network isolation**: By default, containers run with `--network=none` (complete network isolation). When a network allowlist is configured, traffic is routed through a gateway-side proxy that only permits connections to explicitly allowlisted hostnames.
- **Filesystem isolation**: The container only sees the project directory (`/workspace`), the agent modules (`/agent-modules`, read-only), and tool extensions (`/tools`, read-only). Host directories like `~/.ssh`, `~/.aws`, and `~/.config` are not accessible.
- **Credential isolation**: Only explicitly configured `sandbox_credentials` environment variables are passed into the container.

## Customization

To add additional packages, extend the Dockerfile:

```dockerfile
FROM bobbit-agent

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    your-package-here \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
USER node
```

To use a different base image (e.g. for a different Node.js version):

```dockerfile
FROM node:22-slim

# Copy the same setup from the original Dockerfile...
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential python3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && apt-get clean

USER node
WORKDIR /workspace
```

After building a custom image, update `sandbox_image` in your Bobbit project settings to point to it.

## Usage

This image is used automatically by Bobbit when sandbox mode is enabled. You do not need to run `docker run` manually. Configure sandbox mode in your project settings:

1. Set `sandbox` to `"docker"` in project config
2. Build the image: `docker build -t bobbit-agent docker/`
3. Enable the "Sandbox" checkbox when creating a new session

See the main Bobbit documentation for full sandbox configuration options including network allowlists, credentials, and additional mounts.
