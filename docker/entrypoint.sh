#!/bin/bash
set -e

# bobbit-entrypoint.sh — Container entrypoint for Bobbit sandbox containers.
#
# Cross-platform node_modules strategy:
# When the host is Windows/macOS, the bind-mounted node_modules contain native
# addons compiled for the wrong platform. This script detects the mismatch and
# installs a Linux-native copy, cached by package-lock.json hash so subsequent
# container starts are instant.
#
# Cache location: /home/node/.node_modules_cache/<sha256>/node_modules/
# The cache persists across container restarts when the cache dir is a volume.

NODE_MODULES_CACHE="/home/node/.node_modules_cache"

prepare_node_modules() {
    # Only if the project has a package-lock.json
    if [ ! -f /workspace/package-lock.json ]; then
        return 0
    fi

    # If node_modules already has a Linux platform marker, skip
    if [ -f /workspace/node_modules/.bobbit-platform ] && \
       [ "$(cat /workspace/node_modules/.bobbit-platform 2>/dev/null)" = "linux-$(uname -m)" ]; then
        return 0
    fi

    # Quick platform check: try to run a known native binary
    # If esbuild (very common) works, the node_modules are platform-compatible
    if [ -x /workspace/node_modules/.bin/esbuild ] && \
       /workspace/node_modules/.bin/esbuild --version >/dev/null 2>&1; then
        # Mark as compatible so future starts skip this check
        echo "linux-$(uname -m)" > /workspace/node_modules/.bobbit-platform 2>/dev/null || true
        return 0
    fi

    # node_modules are missing or wrong platform — need Linux-native copy
    local lock_hash
    lock_hash=$(sha256sum /workspace/package-lock.json | cut -d' ' -f1)
    local cache_dir="${NODE_MODULES_CACHE}/${lock_hash}"

    if [ -d "${cache_dir}/node_modules" ]; then
        echo "[bobbit-entrypoint] Using cached node_modules (${lock_hash:0:12})"
    else
        echo "[bobbit-entrypoint] Installing Linux-native node_modules (${lock_hash:0:12})..."
        local tmp_dir="${NODE_MODULES_CACHE}/_installing_${lock_hash}"
        rm -rf "${tmp_dir}"
        mkdir -p "${tmp_dir}"

        # Copy package files for npm ci
        cp /workspace/package.json "${tmp_dir}/"
        cp /workspace/package-lock.json "${tmp_dir}/"

        # npm ci into the temp dir
        if npm ci --prefix "${tmp_dir}" --no-audit --no-fund 2>&1 | tail -20; then
            rm -rf "${cache_dir}"
            mv "${tmp_dir}" "${cache_dir}"
            echo "linux-$(uname -m)" > "${cache_dir}/node_modules/.bobbit-platform"
            echo "[bobbit-entrypoint] node_modules cached successfully"
        else
            echo "[bobbit-entrypoint] WARNING: npm ci failed — tests requiring native modules may fail"
            rm -rf "${tmp_dir}"
            return 0
        fi
    fi

    # Overlay: bind-mount the cached node_modules over /workspace/node_modules
    # We can't actually re-mount inside the container, so instead we set NODE_PATH
    # and create a wrapper. But NODE_PATH doesn't fully work for all resolution cases.
    #
    # Best approach: copy the cached modules into /workspace/node_modules if writable,
    # or set NODE_PATH as fallback.
    if [ -w /workspace ]; then
        # Remove or rename the host's node_modules and symlink to cache
        if [ -d /workspace/node_modules ] && [ ! -L /workspace/node_modules ]; then
            mv /workspace/node_modules /workspace/.node_modules_host 2>/dev/null || true
        fi
        # Only symlink if mv succeeded (node_modules is gone or already a symlink).
        # If mv failed, node_modules is still a real directory — ln -sfn would create
        # a symlink INSIDE it (node_modules/node_modules → container path) which leaks
        # to the host via bind mount and breaks npm on the host.
        if [ ! -d /workspace/node_modules ] || [ -L /workspace/node_modules ]; then
            ln -sfn "${cache_dir}/node_modules" /workspace/node_modules 2>/dev/null || {
                # Symlink failed (e.g. cross-device) — restore and fall back to NODE_PATH
                if [ -d /workspace/.node_modules_host ]; then
                    mv /workspace/.node_modules_host /workspace/node_modules 2>/dev/null || true
                fi
                export NODE_PATH="${cache_dir}/node_modules${NODE_PATH:+:$NODE_PATH}"
            }
        else
            # mv failed — fall back to NODE_PATH (safe, no host-side mutation)
            export NODE_PATH="${cache_dir}/node_modules${NODE_PATH:+:$NODE_PATH}"
        fi
        # Clean up stale symlink from previous buggy runs
        if [ -L /workspace/node_modules/node_modules ]; then
            rm -f /workspace/node_modules/node_modules 2>/dev/null || true
        fi
    else
        export NODE_PATH="${cache_dir}/node_modules${NODE_PATH:+:$NODE_PATH}"
    fi

    # Persist NODE_PATH for child processes
    echo "export NODE_PATH=\"${NODE_PATH:-}\"" > /home/node/.bobbit-env 2>/dev/null || true
}

# Prepare node_modules (non-fatal — container still works without it)
prepare_node_modules || true

# Source the env file if it exists (for NODE_PATH)
[ -f /home/node/.bobbit-env ] && . /home/node/.bobbit-env

# Install Playwright browser binary matching the project's @playwright/test version.
# System libs are pre-installed in the Docker image; this only downloads the browser.
# Runs once — subsequent starts skip if the binary already exists.
install_playwright_browsers() {
    # Only if the project uses Playwright
    if [ ! -f /workspace/node_modules/@playwright/test/package.json ] && \
       [ ! -f /workspace/node_modules/playwright/package.json ]; then
        return 0
    fi

    # Check if chromium is already installed for this version
    local pw_version
    pw_version=$(node -e "try{console.log(require('/workspace/node_modules/@playwright/test/package.json').version)}catch{}" 2>/dev/null)
    if [ -z "$pw_version" ]; then
        pw_version=$(node -e "try{console.log(require('/workspace/node_modules/playwright/package.json').version)}catch{}" 2>/dev/null)
    fi
    if [ -z "$pw_version" ]; then return 0; fi

    # npx playwright install is idempotent — skips if already installed
    echo "[bobbit-entrypoint] Ensuring Playwright $pw_version chromium browser..."
    npx -y playwright@"$pw_version" install chromium 2>/dev/null || true
}
install_playwright_browsers || true

# Execute the command
exec "$@"
