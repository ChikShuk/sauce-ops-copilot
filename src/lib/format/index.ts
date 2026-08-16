/**
 * The presentation layer: every enum, key, identifier and timestamp mapped to
 * operator-facing copy, in one place.
 *
 * It lives under `src/lib/` rather than beside the components because it is not
 * only the UI that needs it — the fallback enrichment writer formats dates into
 * the prose it stores, and the worker imports that. Which is also why nothing
 * here may import React or an icon set: this module has to be safe to load in a
 * plain Node process. Icon mappings live in `src/app/components/icons.tsx`.
 *
 * Display only. Stored values never change, so correlation, priority scoring
 * and the LLM boundary are untouched by anything in this folder.
 */

export * from "./datetime";
export * from "./identifiers";
export * from "./labels";
export * from "./usage";
