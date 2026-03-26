# Run from Checkout

The `run` (Linux/macOS) and `run.cmd` (Windows) scripts at the repo root let you launch a production Bobbit server directly from a git checkout, pointed at any project directory. No global install required.

## When to use this

| Approach | Best for |
|---|---|
| `npx bobbit` / `npm install -g bobbit` | Published release, no source needed |
| `npm start` (from repo) | Developing Bobbit itself |
| **`run` / `run.cmd`** | Running Bobbit from source against any project directory |

Use the run scripts when you have a Bobbit checkout and want to use it as a tool across multiple projects without installing globally.

## Prerequisites

- **Node.js** (v18 or later) and **npm** — must be on your PATH
- **git** — for cloning the Bobbit repo

## Usage

### Linux / macOS

```bash
# From any project directory:
/path/to/bobbit/run

# Or if you cloned bobbit to ~/tools/bobbit:
~/tools/bobbit/run

# With extra flags:
/path/to/bobbit/run --host 0.0.0.0 --no-tls --port 3005
```

### Windows

```cmd
rem From any project directory:
C:\path\to\bobbit\run.cmd

rem With extra flags:
C:\path\to\bobbit\run.cmd --host 0.0.0.0 --no-tls --port 3005
```

Works from both cmd.exe and PowerShell.

## What happens on first run

If `node_modules/` or `dist/server/cli.js` is missing, the script automatically runs:

```
npm install
npm run build
```

This is a one-time cost (typically 30–60 seconds). Subsequent runs skip the bootstrap and start immediately.

## How isolation works

Each project directory gets its own isolated Bobbit instance:

- **State** is stored in `<project-dir>/.bobbit/` — sessions, goals, tasks, auth tokens, and TLS certificates are all per-project.
- **Ports** auto-increment from 3001 to 3010, so you can run multiple instances simultaneously for different projects.
- **Working directory** defaults to where you invoke the script. The agent operates on your project files, not the Bobbit checkout.

```
~/projects/frontend/  →  .bobbit/  (port 3001)
~/projects/backend/   →  .bobbit/  (port 3002)
~/projects/infra/     →  .bobbit/  (port 3003)
```

## Argument forwarding

All arguments are forwarded to the Bobbit CLI after an implicit `--cwd <your-working-directory>`:

```bash
# These are equivalent:
/path/to/bobbit/run --host 0.0.0.0 --port 3005
node /path/to/bobbit/dist/server/cli.js --cwd "$(pwd)" --host 0.0.0.0 --port 3005
```

If you pass `--cwd` explicitly, it overrides the implicit working directory (last `--cwd` wins):

```bash
# Use a different project directory:
/path/to/bobbit/run --cwd /other/project
```

See the main [CLI flags](../README.md#cli-flags) for all available options.

## Adding to PATH

### Linux / macOS — symlink

```bash
# Create a symlink in a directory already on your PATH:
ln -s /path/to/bobbit/run /usr/local/bin/bobbit

# Now you can run from anywhere:
cd ~/my-project
bobbit
bobbit --host 0.0.0.0
```

The script resolves symlinks, so this works correctly regardless of where the symlink points.

### Windows — add to PATH

Add the Bobbit checkout directory to your system or user PATH:

1. Open **Settings → System → About → Advanced system settings → Environment Variables**
2. Edit the **Path** variable (user or system)
3. Add the Bobbit checkout directory (e.g. `C:\tools\bobbit`)
4. Open a new terminal and run:

```cmd
run.cmd
```

Alternatively, create a doskey alias in your shell profile:

```cmd
doskey bobbit=C:\tools\bobbit\run.cmd $*
```

## Troubleshooting

### "Node.js is required but not found on PATH"

Install Node.js from [nodejs.org](https://nodejs.org/) (v18 or later) and ensure `node` is on your PATH. Verify with:

```bash
node --version
```

### Build fails during bootstrap

If `npm install` or `npm run build` fails on first run:

1. Check your Node.js version — v18+ is required
2. Try running manually from the Bobbit checkout:
   ```bash
   cd /path/to/bobbit
   npm install
   npm run build
   ```
3. Fix any errors, then re-run the `run` script from your project directory

### Port conflicts

If Bobbit can't bind to a port (all 3001–3010 taken), either:

- Stop an existing instance
- Specify a port explicitly: `./run --port 3020`

### Stale build

If the Bobbit checkout is updated (e.g. `git pull`), the existing `dist/` may be outdated but the bootstrap check won't re-trigger (since `dist/server/cli.js` still exists). Rebuild manually:

```bash
cd /path/to/bobbit
npm install
npm run build
```
