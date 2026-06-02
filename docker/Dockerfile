FROM node:22-slim

# Install build tools, git, curl, gh CLI, ripgrep.
#
# NOTE: we deliberately do NOT install Debian's `fd-find` apt package — at the
# time of writing it ships fd 8.6.0 (bookworm), which predates `--no-require-git`
# (added in fd 9.0). pi-coding-agent 0.74+ passes `--no-require-git`
# unconditionally, so the apt fd fails every `find` tool call inside the
# sandbox. Instead we pull a fixed-version fd binary from sharkdp's GitHub
# release below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential python3 ripgrep \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install fd from sharkdp/fd GitHub release (must be >= 9.0 for --no-require-git).
# Pinned to a known-good version; bump as needed.
ARG FD_VERSION=10.2.0
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) fd_arch="x86_64-unknown-linux-gnu" ;; \
      arm64) fd_arch="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    tarball="fd-v${FD_VERSION}-${fd_arch}.tar.gz"; \
    url="https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${tarball}"; \
    curl -fsSL "$url" -o /tmp/fd.tar.gz; \
    tar -xzf /tmp/fd.tar.gz -C /tmp; \
    install -m 0755 "/tmp/fd-v${FD_VERSION}-${fd_arch}/fd" /usr/local/bin/fd; \
    ln -sf /usr/local/bin/fd /usr/local/bin/fdfind; \
    rm -rf /tmp/fd.tar.gz "/tmp/fd-v${FD_VERSION}-${fd_arch}"; \
    fd --version

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
#
# NOTE: package scope is @earendil-works (renamed from @mariozechner). The host
# detects its own pi-coding-agent version from node_modules and passes it in via
# --build-arg PI_AGENT_VERSION=<host-version>; the ARG default below is only a
# fallback for manual `docker build docker/` invocations.
ARG PI_AGENT_VERSION=0.74.0
RUN npm install -g @earendil-works/pi-coding-agent@${PI_AGENT_VERSION} --no-audit --no-fund 2>/dev/null \
    && ln -sf $(npm root -g) /node_modules
RUN node --input-type=module <<'NODE'
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
const marker = "bobbit-pi-ai-bedrock-headers-patch-v1";
const helper = `
const BOBBIT_PI_AI_BEDROCK_HEADERS_PATCH = "${marker}";
function applyBobbitBedrockRequestHeaders(client, model, options) {
    if (model?.provider !== "aigw") return;
    const headerSource = options?.headers;
    if (!headerSource || typeof headerSource !== "object") return;
    const headerEntries = Object.entries(headerSource).filter((entry) => typeof entry[1] === "string" && entry[1].length > 0);
    if (headerEntries.length === 0) return;
    const middleware = (next) => async (args) => {
        const requestHeaders = args?.request?.headers;
        if (requestHeaders && typeof requestHeaders === "object") {
            for (const [key, value] of headerEntries) {
                const lowerKey = key.toLowerCase();
                for (const existingKey of Object.keys(requestHeaders)) {
                    if (existingKey.toLowerCase() === lowerKey) delete requestHeaders[existingKey];
                }
                requestHeaders[key] = value;
            }
        }
        return next(args);
    };
    try {
        client.middlewareStack.addRelativeTo(middleware, { relation: "after", toMiddleware: "getUserAgentMiddleware", name: "bobbitBedrockRequestHeadersMiddleware", override: true });
    }
    catch {
        client.middlewareStack.add(middleware, { step: "build", priority: "low", name: "bobbitBedrockRequestHeadersMiddleware", override: true });
    }
}
`;
const npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
const candidates = [
  path.join(npmRoot, "@earendil-works", "pi-ai", "dist", "providers", "amazon-bedrock.js"),
  path.join(npmRoot, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "amazon-bedrock.js"),
];
for (const file of candidates) {
  if (!existsSync(file)) continue;
  const source = readFileSync(file, "utf8");
  if (source.includes(marker)) continue;
  const importAnchor = `import { transformMessages } from "./transform-messages.js";\n`;
  const clientAnchor = `            const client = new BedrockRuntimeClient(config);\n`;
  if (!source.includes(importAnchor) || !source.includes(clientAnchor)) throw new Error(`Unsupported pi-ai Bedrock provider shape: ${file}`);
  writeFileSync(file, source.replace(importAnchor, `${importAnchor}${helper}`).replace(clientAnchor, `${clientAnchor}            applyBobbitBedrockRequestHeaders(client, model, options);\n`));
}
NODE
LABEL bobbit.pi-agent-version=${PI_AGENT_VERSION}
LABEL bobbit.pi-ai-bedrock-ua-patch=1

# TypeScript compiler — needed for `npm run check` in worktrees.
# Must run as root (before USER node) to write to /usr/local/lib/node_modules/.
RUN npm install -g typescript --no-audit --no-fund 2>/dev/null

# Run as non-root user. node:22-slim includes a 'node' user (uid=1000).
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
