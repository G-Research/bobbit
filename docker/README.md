# Bobbit Agent Sandbox Image

Minimal Docker image for running Bobbit agent sessions in a sandboxed environment. When sandbox mode is enabled in Bobbit, agent processes run inside this container with restricted filesystem, network, and credential access.

## Build

```bash
docker build -t bobbit-agent docker/
```

The default image name `bobbit-agent` matches Bobbit's default `sandbox_image` config. To use a different name, update `sandbox_image` in your project settings.

**Auto-build**: When `sandbox: "docker"` is configured and the image doesn't exist, the Bobbit gateway automatically builds it on startup from this Dockerfile (120s timeout). You can also trigger a build manually from Settings → Project tab → Docker Sandbox → "Build Image" button, or via `POST /api/sandbox-image/build`. A manual build is not normally needed — the auto-build handles the first-run case.

## What's Included

- **Node.js 20** (slim base) — runtime for the agent process
- **git** — version control operations
- **curl** — HTTP requests
- **gh CLI** — GitHub CLI for PR creation, issue management, etc.
- **build-essential** — gcc, g++, make for native Node.js module compilation
- **python3** — required by some native module build systems (e.g. node-gyp)
- **ripgrep** — fast file search (used by grep tool)

## Cross-Platform node_modules

When the Bobbit server runs on Windows or macOS but agents run inside Linux containers, the host's `node_modules` contain native addons (esbuild, playwright, etc.) compiled for the wrong platform. The image includes an entrypoint script (`bobbit-entrypoint.sh`) that handles this automatically:

1. **Detection**: On container start, the entrypoint checks if `node_modules` are platform-compatible by testing a known native binary (esbuild).
2. **Install**: If incompatible, runs `npm ci` inside the container to produce Linux-native modules.
3. **Cache**: The result is cached in a Docker named volume (`bobbit-nm-cache-<hash>`) indexed by the `package-lock.json` SHA-256 hash. Only the first container pays the install cost — subsequent containers reuse the cache instantly.
4. **Symlink**: The cached `node_modules` are symlinked into `/workspace/node_modules`, replacing the host's incompatible copy within the container.

This means tests run at full speed in the container regardless of the host OS.

### Cache volumes

Two named Docker volumes are created per project:

| Volume | Purpose |
|---|---|
| `bobbit-nm-cache-<hash>` | Cached Linux-native `node_modules` indexed by lockfile hash |
| `bobbit-npm-cache-<hash>` | npm download cache (speeds up `npm ci`) |

These persist across container restarts and are shared by all pool containers for the same project. To clear the cache:

```bash
docker volume rm bobbit-nm-cache-<hash> bobbit-npm-cache-<hash>
```

## Design

The agent CLI (`@mariozechner/pi-coding-agent`) is **not** installed in the image. It is bind-mounted from the host at runtime:

```
-v <hostNodeModules>:/node_modules:ro
```

This ensures:
- The container always uses the **same agent version** as the gateway
- The image stays lightweight and doesn't need rebuilding on agent updates
- No version drift between sandboxed and non-sandboxed sessions

Project `node_modules` (the project's own dependencies used for builds and tests) are handled separately by the entrypoint's cross-platform cache.

Bobbit handles all mount and environment configuration automatically when launching sandboxed sessions.

## Security

- **Non-root execution**: Runs as the `node` user (uid=1000), not root. Files created in the bind-mounted workspace are owned by uid=1000 on the host, matching typical developer user IDs. A container escape does not grant host root access.
- **No Docker socket**: The Docker socket (`/var/run/docker.sock`) is never mounted. The container cannot control Docker or escape to the host.
- **Network control**: Containers run on a dedicated Docker bridge network (`bobbit-sandbox-net`) with direct outbound internet access. Inter-container communication is disabled (`enable_icc=false`). Cloud metadata endpoints (`metadata.google.internal`, `metadata.internal`) are blackholed via `--add-host` entries. The gateway is reachable via `host.docker.internal`. `web_search` and `web_fetch` use direct `curl` from inside the container.
- **Filesystem isolation**: The container only sees the project directory (`/workspace`), the agent modules (`/node_modules`, read-only), and tool extensions (`/tools`, read-only). Host directories like `~/.ssh`, `~/.aws`, and `~/.config` are not accessible.
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
    git curl ca-certificates build-essential python3 ripgrep \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && apt-get clean

# Cross-platform entrypoint
COPY entrypoint.sh /usr/local/bin/bobbit-entrypoint.sh
RUN chmod +x /usr/local/bin/bobbit-entrypoint.sh

USER node
RUN git config --global core.autocrlf true
RUN mkdir -p /home/node/.npm-cache /home/node/.node_modules_cache
ENV npm_config_cache=/home/node/.npm-cache
WORKDIR /workspace

ENTRYPOINT ["bobbit-entrypoint.sh"]
CMD ["sleep", "infinity"]
```

After building a custom image, update `sandbox_image` in your Bobbit project settings to point to it.

## Usage

This image is used automatically by Bobbit when sandbox mode is enabled. You do not need to run `docker run` manually. Configure sandbox mode in your project settings:

1. Set `sandbox` to `"docker"` in project config
2. The image is built automatically on the next server startup if missing — or build manually: `docker build -t bobbit-agent docker/`
3. Enable the "Sandbox" checkbox when creating a new session

See the main Bobbit documentation for full sandbox configuration options including credentials and additional mounts.
