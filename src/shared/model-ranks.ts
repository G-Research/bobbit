/**
 * Shared recency ranks for model IDs. Centralised so server-side
 * (`model-registry.ts`, `aigw-manager.ts`) and client-side
 * (`ModelSelector.ts`) ranking logic stay in lock-step.
 */

/**
 * Recency rank for the speculative GPT-5.5 tier. Higher = newer/better.
 * Used to sort model lists so future-flagship variants surface first.
 */
export const GPT_55_RECENCY_RANK = 104;
