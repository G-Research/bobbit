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

## Auto-rebuild on source changes

After the initial bootstrap, the scripts detect when source files are newer than the build output and rebuild automatically before launching. This means `git pull` followed by `./run` just works — no manual rebuild needed.

The staleness check compares file modification times:

- **Server**: `src/server/`, `package.json`, `tsconfig.server.json` vs `dist/server/cli.js` — runs `npm run build:server` if stale.
- **UI**: `src/ui/`, `src/app/` vs `dist/ui/index.html` — runs `npm run build:ui` if stale.

When a rebuild is needed, the script prints a short message (e.g. `⚡ Server source changed — rebuilding...`) and rebuilds only the stale parts. When the build is fresh, there is no output and no delay. If a rebuild fails, the script exits with an error code rather than launching with stale code.

On Linux/macOS, staleness detection uses `find -newer ... -print -quit` which exits at the first newer file found — effectively instant. On Windows, an inline PowerShell snippet compares timestamps via `Get-ChildItem -Recurse`.

## How isolation works

Each project directory gets its own isolated Bobbit instance:

- **State** is stored in `<project-dir>/.bobbit/` — sessions, goals, tasks, auth tokens, and TLS certificates are all per-project.
- **Ports** auto-increment (up to 9 above the base port) so you can run multiple instances simultaneously for different projects.
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

If Bobbit can't bind to a port (all ports in the auto-increment range are taken), either:

- Stop an existing instance
- Specify a port explicitly: `./run --port 3020`

### Stale build

The run scripts automatically detect when source files are newer than the build output and rebuild before launching (see [Auto-rebuild on source changes](#auto-rebuild-on-source-changes)). In most cases, `git pull` followed by `./run` is sufficient.

If auto-rebuild doesn't catch a change (e.g. a dependency update that doesn't touch source files), rebuild manually:

```bash
cd /path/to/bobbit
npm install
npm run build
```
