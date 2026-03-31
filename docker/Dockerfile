FROM node:20-slim

# Install build tools, git, curl, gh CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential python3 ripgrep \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && apt-get clean

# Entrypoint script for cross-platform node_modules preparation
COPY entrypoint.sh /usr/local/bin/bobbit-entrypoint.sh
RUN chmod +x /usr/local/bin/bobbit-entrypoint.sh

# Run as non-root user. node:20-slim includes a 'node' user (uid=1000).
# This ensures files created in /workspace via bind mount are owned by uid=1000
# on the host, matching typical developer user IDs.
USER node

# Configure git for Windows host compatibility (CRLF line endings).
# Commit identity comes from the mounted repo's .git/config (the human developer).
RUN git config --global core.autocrlf true

# npm cache directory (persisted via volume for faster installs)
RUN mkdir -p /home/node/.npm-cache
ENV npm_config_cache=/home/node/.npm-cache

# Node_modules cache directory — stores Linux-native node_modules indexed by
# package-lock.json hash. Survives container restarts when the home dir is
# a named volume, eliminating reinstalls on subsequent starts.
RUN mkdir -p /home/node/.node_modules_cache

WORKDIR /workspace

ENTRYPOINT ["bobbit-entrypoint.sh"]
CMD ["sleep", "infinity"]
