// Turns the settings profile the platform ships with every call into a live
// ClickHouse connection, and pools one client per distinct connection.
//
// The plugin holds no database configuration of its own. A connection travels
// in each request as `body.settings`, the same named profile the runtime folds
// into action bodies — so one running plugin can serve many databases and
// rotating a password needs no redeploy. The Node counterpart of the Postgres
// plugin's internal/postgres/settings.go.

import { createHash } from "node:crypto";

import { Client } from "./client.js";

/**
 * ErrNoSettings is thrown when a call arrives without a connection. It is phrased
 * for the person looking at the node, since that is where the fix is.
 */
export const ErrNoSettings =
  "this node has no ClickHouse connection: pick a settings profile in the node drawer (URL, or host / database / user / password) or create one from the plugin's set-up form";

/** requestTimeoutMs bounds one HTTP request to ClickHouse (2 minutes). */
const requestTimeoutMs = 2 * 60 * 1000;

/**
 * Config is a resolved ClickHouse connection. Either a full URL is given, or the
 * discrete fields are; both are reduced to what `@clickhouse/client` needs.
 */
export interface Config {
  url: string;
  username: string;
  password: string;
  database: string;
  /** host:port/database — enough to name the target, with no credentials in it. */
  connInfo: string;
  requestTimeoutMs: number;
}

// Field synonyms, in preference order. Each entry is already canonical (lower
// case, letters and digits only) — see canonicalKey.
const urlKeys = ["url", "dsn", "connectionstring", "connstring", "connectionurl", "uri", "connuri"];
const hostKeys = ["host", "hostname", "server", "address", "endpoint"];
const portKeys = ["port"];
const databaseKeys = ["database", "dbname", "db", "schema"];
const userKeys = ["user", "username", "login", "account"];
const passwordKeys = ["password", "pass", "pwd", "secret", "apikey", "token"];
const secureKeys = ["secure", "ssl", "tls", "https"];
const protocolKeys = ["protocol", "scheme"];

/**
 * parseConfig reads a connection out of the settings profile the platform ships
 * with every action call as `body.settings`.
 *
 * The profile is a free-form key/value record: filled from the plugin's own
 * set-up form when the platform could read it, and hand-typed otherwise. So keys
 * are matched leniently — case, spaces, dashes and underscores are ignored, and
 * the usual synonyms for each field are accepted.
 */
export function parseConfig(settings: Record<string, unknown> | undefined): Config {
  if (!settings || Object.keys(settings).length === 0) {
    throw new Error(ErrNoSettings);
  }

  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(settings)) {
    const text = toString(value);
    if (text !== "") values.set(canonicalKey(key), text);
  }

  const rawUrl = pick(values, urlKeys);
  const host = pick(values, hostKeys);
  const database = pick(values, databaseKeys);
  const user = pick(values, userKeys);
  const password = pick(values, passwordKeys);

  if (rawUrl === "" && host === "") {
    // Something was configured, but none of it is a ClickHouse connection — most
    // likely the wrong profile is selected on the node.
    throw new Error(
      `${ErrNoSettings} (the selected profile has none of these: ${sortedKeys(settings).join(", ")})`,
    );
  }

  const secure =
    isTruthy(pick(values, secureKeys)) ||
    pick(values, protocolKeys).toLowerCase() === "https" ||
    /^https:\/\//i.test(rawUrl);

  let url: string;
  let connHost: string;
  let connPort: string;

  if (rawUrl !== "") {
    // A URL given verbatim wins outright — a user who pasted one means it.
    url = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `${secure ? "https" : "http"}://${rawUrl}`;
    try {
      const parsed = new URL(url);
      connHost = parsed.hostname;
      connPort = parsed.port || (parsed.protocol === "https:" ? "8443" : "8123");
    } catch {
      throw new Error(`invalid ClickHouse URL: ${rawUrl}`);
    }
  } else {
    const protocol = secure ? "https" : "http";
    connPort = pick(values, portKeys) || (secure ? "8443" : "8123");
    connHost = host;
    url = `${protocol}://${host}:${connPort}`;
  }

  return {
    url,
    username: user || "default",
    password,
    database,
    connInfo: `${connHost}:${connPort}/${database || "default"}`,
    requestTimeoutMs,
  };
}

/** fingerprint identifies a connection without keeping the password in a map key. */
function fingerprint(cfg: Config): string {
  return createHash("sha256")
    .update(`${cfg.url}\n${cfg.username}\n${cfg.password}\n${cfg.database}`)
    .digest("hex");
}

// maxPooledClients bounds the cache: a handful of profiles is the norm, and the
// pool is drained rather than grown without limit if that ever changes.
const maxPooledClients = 16;

/**
 * Pool hands out one client per distinct connection, so every job using the same
 * settings profile shares one `@clickhouse/client` instead of opening afresh.
 */
export class Pool {
  private readonly clients = new Map<string, Client>();

  /** Resolve the settings profile shipped with a call into a client. */
  client(settings: Record<string, unknown> | undefined): Client {
    const cfg = parseConfig(settings);
    return this.for(cfg);
  }

  /** Return the client for an already-parsed config, opening one on first use. */
  for(cfg: Config): Client {
    const key = fingerprint(cfg);
    const existing = this.clients.get(key);
    if (existing) return existing;

    if (this.clients.size >= maxPooledClients) {
      for (const [k, c] of this.clients) {
        void c.close();
        this.clients.delete(k);
      }
    }
    const client = new Client(cfg);
    this.clients.set(key, client);
    return client;
  }
}

// ---------------------------------------------------------------- helpers --

function pick(values: Map<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined) return value;
  }
  return "";
}

// canonicalKey reduces a settings key to letters and digits, lower case, so
// "Host name", "host_name" and "hostName" are one key.
function canonicalKey(key: string): string {
  let out = "";
  for (const ch of key.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
  }
  return out;
}

// toString renders a profile value. The settings editor stores anything that
// parses as JSON (numbers, booleans) as that type, so values are not always
// strings — a port arrives as a number.
function toString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value).trim();
}

function isTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on" || v === "require" || v === "https";
}

function sortedKeys(settings: Record<string, unknown>): string[] {
  return Object.keys(settings).sort();
}
