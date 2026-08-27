// Command clickhouse-plugin is an Inflowenger plugin node for ClickHouse.
//
// It exposes four actions on the workflow canvas — run a read query, execute a
// write/DDL statement, insert a record, and create a table if it does not
// already exist — over a connection the platform ships with every call.
//
// The plugin holds no database configuration. It declares what a connection
// needs (see the settings form); the platform stores that as a named settings
// profile and ships the values with every call as `body.settings`. The Node
// counterpart of the Go Postgres plugin.

import { newPlugin, withDotEnv, withTimeout } from "@inflowenger/node-plugin-sdk";

import { Registry } from "./actions/registry.js";

const version = "v0.1.0";

// A read against a slow ClickHouse server (a large aggregation) can run well past
// the SDK's 5s default reply deadline. Raise it so a slow answer arrives as a
// real result/error rather than a bare NATS "TIMEOUT". REQ_TIMEOUT overrides it.
const SEND_TIMEOUT_SECONDS = 130;

async function main() {
  const envFile = process.env.INFLOW_ENV_FILE || ".env.inflow";

  // The dotenv carries the platform identity only — PLUGIN_ID, INFRA_CRED,
  // INFRA_URL. ClickHouse credentials never live here.
  const p = await newPlugin(withDotEnv(envFile), withTimeout(SEND_TIMEOUT_SECONDS));

  const registry = new Registry();

  p.intro({
    name: "CLICKHOUSE",
    author: "FloMorphic",
    version,
    settings: registry.settingsForm(),
  });
  p.requiredParams(registry.settings());

  const actions = registry.all();
  p.addAction(...actions);
  p.addMeta(...registry.metas());

  p.start();

  const methods = actions.map((a) => a.method).join(", ");
  console.log(`clickhouse plugin ${version} ready with ${actions.length} actions: ${methods}`);
  console.log("clickhouse plugin: each call brings its own connection in body.settings — bind a settings profile to the node");

  // start() only wires up subscriptions; the process has to stay alive to serve
  // them.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
