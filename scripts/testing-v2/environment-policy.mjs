/**
 * Shared environment policy for cross-suite test coordinators.
 *
 * Environment names are case-insensitive on Windows. Every coordinator builds a
 * plain object before spawning children, so use these helpers instead of direct
 * property assignment/deletion whenever a fixture or harness owns a key.
 */
export const CREDENTIAL_ENV_EXACT_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_AUTH",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_GENAI_USE_GCA",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "AWS_BEDROCK_SKIP_AUTH",
  "NPM_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AIGW_OPENCODE_TOKEN",
]);

export const CREDENTIAL_ENV_PREFIXES = [
  "CLAUDE_CODE_",
  "ANTHROPIC_",
  "OPENAI_",
  "OPENROUTER_",
  "GEMINI_",
  "GOOGLE_",
  "AWS_",
  "AIGW_",
  "OPENCODE_",
  "GITHUB_",
  "GH_",
  "AZURE_",
  "COHERE_",
  "MISTRAL_",
  "GROQ_",
  "TOGETHER_",
  "DEEPSEEK_",
  "XAI_",
];

/** Actual production inputs that can bind tests to an ambient Bobbit runtime. */
export const AMBIENT_BOBBIT_RUNTIME_ENV_NAMES = new Set([
  "BOBBIT_BUILTIN_PACKS_DIR",
  "BOBBIT_BUILTIN_TOOLS",
  "BOBBIT_GATEWAY_URL",
  "BOBBIT_TOKEN",
  "BOBBIT_SESSION_ID",
  "BOBBIT_SESSION_SECRET",
  "BOBBIT_GH_COMMAND",
]);

/**
 * Git tiers an isolated harness must not inherit from the host.
 *
 * Redirecting HOME already keeps the developer's global gitconfig out, but
 * `/etc/gitconfig` is read regardless of HOME and is only disabled by
 * GIT_CONFIG_NOSYSTEM. A system-level `url.<base>.insteadOf` rewrite silently
 * changes the remote a fixture just wrote, so `git remote get-url origin`
 * returns a host the fixture never set.
 *
 * This disables only the system tier: repo-local config and the (already
 * redirected) global config are untouched, so fixtures operating on real
 * repositories keep real git behaviour.
 */
export const GIT_ISOLATION_ENV = Object.freeze({ GIT_CONFIG_NOSYSTEM: "1" });

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const CREDENTIAL_ENV_PATTERN = new RegExp(
  `^(?:${CREDENTIAL_ENV_PREFIXES.map(escapeRegExp).join("|")}|BOBBIT_.*(?:KEY|TOKEN|SECRET|CREDENTIALS?)$)`,
);

export function normalizeEnvironmentKey(key, platform = process.platform) {
  return platform === "win32" ? key.toUpperCase() : key;
}

export function environmentKeysEqual(a, b, platform = process.platform) {
  return normalizeEnvironmentKey(a, platform) === normalizeEnvironmentKey(b, platform);
}

/** Return a value with the platform's environment-name lookup semantics. */
export function environmentValue(env, name, platform = process.platform) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (platform !== "win32") return undefined;
  const matching = Object.keys(env).find((key) => environmentKeysEqual(key, name, platform));
  return matching === undefined ? undefined : env[matching];
}

/** Replace all spellings of an owned environment key with one canonical name. */
export function setEnvironmentValue(env, name, value, platform = process.platform) {
  for (const key of Object.keys(env)) {
    if (environmentKeysEqual(key, name, platform)) delete env[key];
  }
  env[name] = value;
}

/** Delete every platform-equivalent spelling of a key. */
export function deleteEnvironmentValue(env, name, platform = process.platform) {
  for (const key of Object.keys(env)) {
    if (environmentKeysEqual(key, name, platform)) delete env[key];
  }
}

/** Copy an environment and apply patch values with canonical Windows spellings. */
export function copyEnvironment(env, additions = {}, platform = process.platform) {
  const copy = { ...env };
  for (const [key, value] of Object.entries(additions)) {
    if (value === undefined) deleteEnvironmentValue(copy, key, platform);
    else setEnvironmentValue(copy, key, value, platform);
  }
  return copy;
}

export function isCredentialEnvKey(key, platform = process.platform) {
  const normalized = normalizeEnvironmentKey(key, platform);
  // Test namespaces are deliberate suite controls, even when a control happens
  // to contain TOKEN/KEY/SECRET in its name. Harness-owned paths are replaced
  // separately with setEnvironmentValue(), never discarded as credentials.
  if (normalized.startsWith("BOBBIT_TEST_") || normalized.startsWith("BOBBIT_V2_")) return false;
  return CREDENTIAL_ENV_EXACT_NAMES.has(normalized)
    || CREDENTIAL_ENV_PATTERN.test(normalized);
}

/**
 * Host runtime/discovery inputs are denied explicitly. Test and v2 controls are
 * intentionally not classified by the generic command/adapter matcher: these
 * namespaces carry test-only switches such as BOBBIT_TEST_*TOKEN and
 * BOBBIT_V2_*COMMAND_OVERRIDE.
 */
export function isAmbientBobbitRuntimeEnvKey(key, platform = process.platform) {
  const normalized = normalizeEnvironmentKey(key, platform);
  if (!normalized.startsWith("BOBBIT_")) return false;
  if (normalized.startsWith("BOBBIT_TEST_") || normalized.startsWith("BOBBIT_V2_")) return false;
  return AMBIENT_BOBBIT_RUNTIME_ENV_NAMES.has(normalized)
    || /(?:^|_)(?:SESSION|COMMAND|ADAPTER|CLI|OVERRIDE)(?:_|$)/.test(normalized);
}

export function isAmbientTestEnvironmentKey(key, platform = process.platform) {
  return isCredentialEnvKey(key, platform) || isAmbientBobbitRuntimeEnvKey(key, platform);
}

/** Copy an environment with only credential and host-runtime inputs removed. */
export function sanitizeTestEnvironment(env = process.env, platform = process.platform) {
  const sanitized = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isAmbientTestEnvironmentKey(key, platform))
      sanitized[key] = value;
  }
  return sanitized;
}
