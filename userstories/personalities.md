# Personalities — User Stories

## P-01: View personalities list

**As a** user  
**I want to** navigate to `#/personalities` and see all available personalities  
**So that** I can understand what personality options exist for agent customization

### Acceptance Criteria

- Navigating to `#/personalities` displays all personalities resolved through the config cascade (builtin + server + project layers).
- Each personality entry shows its **name**, **label**, and **description** (if set).
- Each personality displays an **origin badge**: grey for builtin, blue for server, green for project.
- Inherited (non-overridden) personalities render at **70% opacity**.
- When multiple projects are registered, a **project scope row** appears above the list.

### Technical Notes

- Resolution uses `ConfigCascade.resolvePersonalities(projectId)`.
- REST: `GET /api/personalities?projectId=<id>` returns the resolved list with origin metadata.
- Shared UI code in `config-scope.ts` and `config-scope.css`.

### Coverage

**API only.** API endpoint returns correct data but no browser E2E test validates the list page rendering, badges, or scope row.

---

## P-02: Create personality

**As a** user  
**I want to** create a new personality  
**So that** I can define custom behavioral modifiers for agents

### Acceptance Criteria

- Clicking "New" opens a creation form.
- The user fills in: **name** (unique identifier), **label** (display name), **prompt_fragment** (1–2 sentences appended to the agent's system prompt), and optional **description**.
- On save, the personality appears in the list with the appropriate origin badge.
- A YAML file is persisted to the config directory.
- The new personality is immediately available for use in `team_spawn`.

### Technical Notes

- REST: `POST /api/personalities` with JSON body. Accepts optional `projectId`.
- YAML persisted to `<scope>/.bobbit/config/personalities/<name>.yaml`.
- The `prompt_fragment` is the core value — it is appended to the agent's system prompt after the role prompt.

### Coverage

**API only.** CRUD API tests exist but no browser E2E test validates form interaction.

---

## P-03: Edit personality

**As a** user  
**I want to** edit an existing personality's prompt fragment  
**So that** I can refine how the personality modifies agent behavior

### Acceptance Criteria

- Clicking a personality navigates to its edit page.
- The user can modify the **prompt_fragment**, **label**, and **description**.
- On save, changes are persisted to YAML.
- New agent spawns use the updated personality; existing running agents are unaffected.

### Technical Notes

- REST: `PUT /api/personalities/:name` with JSON body.

### Coverage

**API only.** No browser E2E test for the edit page.

---

## P-04: Delete personality

**As a** user  
**I want to** delete a personality I no longer need  
**So that** my personality list stays clean

### Acceptance Criteria

- Clicking "Delete" on a personality shows a confirmation dialog.
- On confirm, the personality is removed from the list and its YAML file is deleted.
- Existing agents currently using this personality are **not** affected — only future spawns.
- Only custom personalities can be deleted; builtins cannot be deleted.

### Technical Notes

- REST: `DELETE /api/personalities/:name` with optional `?projectId=`.

### Coverage

**API only.** No browser E2E test for the delete flow.

---

## P-05: Customize builtin personality (project override)

**As a** user  
**I want to** create a project-level override of a builtin personality  
**So that** I can tailor personality behavior for a specific project

### Acceptance Criteria

- With a project scope selected, clicking "Customize" on a builtin personality copies it to the project config directory.
- The origin badge changes from grey (builtin) to green (project).
- Project sessions use the override; other projects see the builtin.
- Clicking "Revert" removes the override and restores the inherited value.

### Technical Notes

- Customize: `POST /api/personalities/:name/customize?scope=project&projectId=X`.
- Revert: `DELETE /api/personalities/:name/override?scope=project&projectId=X`.
- Same cascade pattern as roles — see `ConfigCascade` in `config-cascade.ts`.

### Coverage

**API only.** No browser E2E test for the Customize/Revert button interactions.

---

## P-06: Personality applied to agent

**As a** user  
**I want** a personality's prompt fragment to be appended to the agent's system prompt when applied  
**So that** the agent's behavior is modified according to the personality definition

### Acceptance Criteria

- When an agent is spawned via `team_spawn` with a `personality` parameter, the personality's `prompt_fragment` is appended to the agent's system prompt **after** the role prompt.
- Multiple personalities can be applied (via role's `defaultPersonalities` or explicit selection) — their fragments are appended in order.
- The personality resolution goes through the config cascade for the goal's project.

### Technical Notes

- Session setup pipeline: `resolvePrompt` step appends personality fragments after the role's `promptTemplate`.
- `personalities_list` tool returns available personalities for use in `team_spawn`.
- `personalities_create` tool allows creating personalities programmatically during a goal.

### Coverage

**None.** No E2E test validates that personality prompt fragments are correctly appended to the agent's system prompt in a spawned session.
