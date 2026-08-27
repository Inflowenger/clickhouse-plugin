// Rewrite {{$...}} tokens in free-text inputs against the flow scope, so the SQL
// text and each parameter can reference upstream data the same way. The Node
// port of the Postgres plugin's vars.go.

import type { Job } from "@inflowenger/node-plugin-sdk";

// {{ $.a.b }} — capture the JSON path inside the mustaches.
const VAR_RE = /\{\{\s*(\$[^}]+?)\s*\}\}/g;

const decoder = new TextDecoder();

/**
 * A per-call resolver for {{$...}} tokens. It holds a cache so each distinct path
 * is fetched from the runtime only once, however many fields reference it — the
 * same value has to reach both the top-level walk and the per-column insert map.
 */
export class VarResolver {
  private readonly cache = new Map<string, string>();

  constructor(private readonly job: Job) {}

  /**
   * Substitute every {{$...}} token in the string. Tokens the scope can't supply
   * are left verbatim so nothing is silently dropped.
   */
  async resolve(text: string): Promise<string> {
    if (!text.includes("{{")) return text;
    const matches = [...text.matchAll(VAR_RE)];
    let out = text;
    for (const m of matches) {
      const path = m[1].trim();
      let value = this.cache.get(path);
      if (value === undefined) {
        value = await this.fetch(path);
        this.cache.set(path, value);
      }
      out = out.replace(m[0], value);
    }
    return out;
  }

  // fetch reads a JSON path from the flow context. The reply is JSON: a JSON
  // string is unwrapped to its value, anything else is returned raw so it can be
  // inlined into the field.
  private async fetch(jsonPath: string): Promise<string> {
    let raw: Uint8Array;
    try {
      raw = await this.job.cmdGetScope(jsonPath);
    } catch {
      return `{{${jsonPath}}}`; // leave the token in place
    }
    if (!raw || raw.length === 0) return `{{${jsonPath}}}`;
    const text = decoder.decode(raw);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not JSON — return the raw bytes as text
    }
    return text;
  }
}

/**
 * Walk the top-level fields of a decoded action input and rewrite {{$...}} tokens
 * in every `string` and `string[]` field in place, sharing one resolver so a
 * path referenced by several fields is fetched once. Plain fields (no token)
 * never hit the runtime, so this is safe to run over every action's input.
 */
export async function resolveInputVars<T extends Record<string, unknown>>(
  job: Job,
  input: T,
  resolver: VarResolver = new VarResolver(job),
): Promise<void> {
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (typeof value === "string") {
      (input as Record<string, unknown>)[key] = await resolver.resolve(value);
    } else if (Array.isArray(value)) {
      const arr = value as unknown[];
      for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] === "string") arr[i] = await resolver.resolve(arr[i] as string);
      }
    }
  }
}
