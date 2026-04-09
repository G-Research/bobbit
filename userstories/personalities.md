# Personalities — User Stories

## P-01: View personalities list

**As a** user
**I want to** see all available personalities on the Personalities page
**So that** I can understand what personality options exist for agent customization

### Acceptance Criteria

- The Personalities page displays all personalities, including built-in defaults and user-created ones.
- Each personality shows its **name**, **label**, and **description** (if set).
- Each personality displays an **origin badge**: grey for builtin, blue for server-level, green for project-level.
- Inherited (non-overridden) personalities appear **dimmed**.
- When multiple projects are registered, a **scope selector** appears above the list.

### Coverage

**API only.** API returns correct data but no browser E2E test validates the list page rendering, badges, or scope selector.

---

## P-02: Create personality

**As a** user
**I want to** create a new personality
**So that** I can define custom behavioral modifiers for agents

### Acceptance Criteria

- Clicking "New" opens a creation form.
- The user fills in: **name**, **label**, **prompt fragment** (1–2 sentences that modify agent behavior), and optional **description**.
- On save, the personality appears in the list.
- The new personality is immediately available for use when spawning team agents.

### Coverage

**API only.** CRUD API tests exist but no browser E2E test validates form interaction.

---

## P-03: Edit personality

**As a** user
**I want to** edit an existing personality
**So that** I can refine how the personality modifies agent behavior

### Acceptance Criteria

- Clicking a personality opens its edit view with current values loaded.
- The user can modify the **prompt fragment**, **label**, and **description**.
- On save, changes are persisted.
- New agent spawns use the updated personality; existing running agents are unaffected.

### Coverage

**API only.** No browser E2E test for the edit interaction.

---

## P-04: Delete personality

**As a** user
**I want to** delete a personality I no longer need
**So that** my personality list stays clean

### Acceptance Criteria

- Clicking "Delete" on a personality shows a confirmation dialog.
- On confirm, the personality is removed from the list.
- Existing agents currently using this personality are **not** affected — only future spawns.
- Only custom personalities can be deleted; builtins cannot.

### Coverage

**API only.** No browser E2E test for the delete flow.

---

## P-05: Customize builtin personality (project override)

**As a** user
**I want to** create a project-level override of a builtin personality
**So that** I can tailor personality behavior for a specific project

### Acceptance Criteria

- With a project scope selected, clicking "Customize" on a builtin personality creates an editable copy for that project.
- The origin badge changes from grey (builtin) to green (project).
- Sessions in that project use the override; other projects see the original builtin.
- Clicking "Revert" removes the override and restores the inherited value, changing the badge back.

### Coverage

**API only.** No browser E2E test for the Customize/Revert button interactions.

---

## P-06: Personality applied to agent

**As a** user
**I want** a personality to modify an agent's behavior when applied
**So that** spawned agents reflect the personality I chose

### Acceptance Criteria

- When a team agent is spawned with a personality, its behavior reflects the personality's prompt fragment.
- Multiple personalities can be applied — their effects combine.
- Personality resolution respects project-level overrides for the goal's project.

### Coverage

**None.** No E2E test validates that personality prompt fragments actually modify agent behavior in a spawned session.
