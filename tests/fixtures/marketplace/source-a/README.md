# Marketplace fixture source-a

A test marketplace source containing several Extension Packs:

- `research-pack/` — valid; role + tool group + skill (tool ⇒ executable code).
- `roles-only-pack/` — valid; a single role.
- `invalid-pack/` — declares a role missing on disk (must surface an error).
- `not-a-pack/` — no `pack.yaml` (must be ignored by the scanner).
