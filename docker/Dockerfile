FROM node:20-slim

# Install build tools, git, curl, gh CLI, fd-find
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential python3 ripgrep fd-find \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && ln -s $(which fdfind) /usr/local/bin/fd 2>/dev/null || true

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && apt-get clean

# Install Playwright system dependencies (Chromium libs) as root.
# Uses a fixed version for broad library coverage. The actual browser binary
# version is controlled by PLAYWRIGHT_VERSION below.
RUN npx -y playwright@1.52.0 install-deps chromium 2>/dev/null \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install pi-coding-agent and its dependencies inside the image.
# This avoids bind-mounting node_modules from the host, which is 20x slower
# on Docker Desktop (Windows/macOS) due to cross-OS filesystem bridging.
ARG PI_AGENT_VERSION=0.57.1
RUN npm install -g @mariozechner/pi-coding-agent@${PI_AGENT_VERSION} --no-audit --no-fund 2>/dev/null \
    && ln -sf $(npm root -g) /node_modules
LABEL bobbit.pi-agent-version=${PI_AGENT_VERSION}

# TypeScript compiler — needed for `npm run check` in worktrees.
# Must run as root (before USER node) to write to /usr/local/lib/node_modules/.
RUN npm install -g typescript --no-audit --no-fund 2>/dev/null

# Run as non-root user. node:20-slim includes a 'node' user (uid=1000).
# This ensures files created in /workspace via bind mount are owned by uid=1000
# on the host, matching typical developer user IDs.
USER node

# Configure git for Windows host compatibility (CRLF line endings).
# Mark /workspace as safe (it's bind-mounted with different ownership).
# Commit identity comes from the mounted repo's .git/config (the human developer).
RUN git config --global core.autocrlf true \
    && git config --global --add safe.directory /workspace \
    && git config --global credential.helper \
    '!f() { test -n "$GITHUB_TOKEN" && echo "username=x-access-token" && echo "password=$GITHUB_TOKEN"; }; f'

# npm cache directory (persisted via volume for faster installs)
RUN mkdir -p /home/node/.npm-cache
ENV npm_config_cache=/home/node/.npm-cache

# Node_modules cache directory — stores Linux-native node_modules indexed by
# package-lock.json hash. Survives container restarts when the home dir is
# a named volume, eliminating reinstalls on subsequent starts.
RUN mkdir -p /home/node/.node_modules_cache

# ── Playwright browser binary ──────────────────────────────────────────────
# ARG placed late so version bumps only rebuild this layer, not pi-agent etc.
# Must match the project's @playwright/test version to avoid re-download at
# container startup. The entrypoint handles mismatches at runtime as a fallback.
ARG PLAYWRIGHT_VERSION=1.58.2
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install chromium

WORKDIR /workspace

CMD ["sleep", "infinity"]
