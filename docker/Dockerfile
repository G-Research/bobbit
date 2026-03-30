FROM node:20-slim

# Install build tools, git, curl, gh CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential python3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && apt-get clean

# Run as non-root user. node:20-slim includes a 'node' user (uid=1000).
# This ensures files created in /workspace via bind mount are owned by uid=1000
# on the host, matching typical developer user IDs.
USER node

# Configure git for Windows host compatibility (CRLF line endings)
# and provide default identity for commits inside the container.
RUN git config --global core.autocrlf true \
    && git config --global user.email "bobbit-agent@bobbit.ai" \
    && git config --global user.name "Bobbit Agent"

WORKDIR /workspace
