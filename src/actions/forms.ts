// Every form this plugin serves, declared with the SDK's formkit builder, which
// generates the JSON Schema and the JSON Forms UI Schema from one statement per
// field. A malformed form throws at start-up (build calls validate), where it is
// a programming mistake rather than a dialog that will not open.
//
// The Node port of the Postgres plugin's forms.go, adapted to ClickHouse: named
// {name:Type} parameters instead of positional $1, a "database" where Postgres
// has a "schema", and an engine / ORDER BY on table creation.

import { formkit } from "@inflowenger/node-plugin-sdk";

// The engines a person reaches for most often, offered as suggestions on the
// engine fields via the JSON Forms `suggestion` renderer option — a free-solo
// autocomplete, so any engine ClickHouse supports (including a custom or
// parameterised one, e.g. ReplicatedMergeTree('/path','{replica}')) can still
// be typed in full.
const tableEngines = [
  "MergeTree",
  "ReplacingMergeTree",
  "SummingMergeTree",
  "AggregatingMergeTree",
  "CollapsingMergeTree",
  "VersionedCollapsingMergeTree",
  "Log",
  "TinyLog",
  "StripeLog",
  "Memory",
];
const databaseEngines = ["Atomic", "Lazy", "Memory", "Replicated"];

const descQuerySQL =
  "SELECT (or any row-returning statement) to run. Pull values straight from the flow with {{$.path}}, e.g. WHERE tenant = '{{$.trigger.tenantId}}'. Bind typed values with ClickHouse named parameters — {id:UInt64} — and supply them in Parameters below.";

const descExecuteSQL =
  "Statement to run: INSERT, ALTER, DROP, TRUNCATE, OPTIMIZE, or any DDL. Returns no rows — use the Query action to read. Bind typed values with ClickHouse named parameters — WHERE id = {id:UInt64} — and set them in Parameters below (never string-concatenate user input).";

const descParams =
  'Optional JSON object of the named parameters referenced in the SQL above, e.g. {"id": 42, "status": "active"}. Each is bound as a ClickHouse query parameter, never pasted into the SQL text, so a value can never alter the query — the type comes from the {name:Type} placeholder. Values may be {{$.path}} tokens: {"orderId": "{{$.trigger.orderId}}"}.';

const descLimit =
  "Most rows to return. Capped at 100 — a larger number is treated as 100. Accepts a {{$.path}} token that resolves to a number.";

const descInsertRecord =
  'Optional JSON object of column → value, e.g. {"event_id": 7, "severity": "high"}. When given, it wins over the column fields above. Values may be {{$.path}} tokens: {"name": "{{$.user.name}}"}. ClickHouse INSERT has no upsert — deduplication is a table-engine concern (e.g. ReplacingMergeTree at merge time).';

// ---------------------------------------------------------------- settings --

// The settings profile the platform stores and ships with every call as
// body.settings. A full URL or the discrete fields — either works; a URL, when
// given, wins.
export const settingsForm = formkit
  .form("ClickHouse connection")
  .describe(
    "Stored by the platform as a reusable settings profile and shipped with every call as body.settings. The plugin keeps nothing. Give a full connection URL, or fill in the fields below.",
  )
  .submitTo("clickhouse.meta.ping.check")
  .add(
    formkit
      .text("url", "Connection URL")
      .describe(
        "http://host:8123 (or https://host:8443 for TLS) — the ClickHouse HTTP interface. Given, it wins; leave empty to use the fields below.",
      ),
    formkit.text("host", "Host").describe("e.g. localhost or clickhouse.internal"),
    formkit.integer("port", "Port").describe("HTTP interface port. Defaults to 8123 (or 8443 when Secure is on)."),
    formkit.text("database", "Database").default("default"),
    formkit.text("user", "User").default("default"),
    formkit.secret("password", "Password"),
    formkit
      .bool("secure", "Secure (HTTPS)")
      .describe("Use the HTTPS interface. Only applies when building the URL from the fields above.")
      .default(false),
    // The button hangs off the last field and its answer appears under it, so a
    // bad connection is reported while it is being entered rather than by every
    // node that later fails. It writes no value — saying what it found is the
    // whole point.
    formkit
      .text("test", "Test connection")
      .describe("Press ↻ to check these values against the live server before saving.")
      .lookup("clickhouse.meta.ping.check", "Test connection"),
  )
  .build();

// ------------------------------------------------------------------ actions --

export const queryForm = formkit
  .form("Run query (read)")
  .add(
    formkit
      .textArea("sql", "SQL")
      .required()
      .describe(descQuerySQL)
      .help(
        "Read-only intent: use this for SELECT. Pull values from the flow inline with {{$.path}}. Writes belong on the Execute or Insert action.",
      ),
    formkit.textArea("params", "Parameters (named)").describe(descParams),
    formkit.text("limit", "Max rows").default("100").describe(descLimit),
  )
  .build();

export const executeForm = formkit
  .form("Execute (write / DDL)")
  .add(
    formkit
      .textArea("sql", "SQL")
      .required()
      .describe(descExecuteSQL)
      .help(
        "INSERT / ALTER / DROP / TRUNCATE / OPTIMIZE / DDL. Example: ALTER TABLE orders UPDATE status = {status:String} WHERE id = {id:UInt64} — with Parameters {\"status\": \"shipped\", \"id\": 42}.",
      ),
    formkit.textArea("params", "Parameters (named)").describe(descParams),
  )
  .build();

// insertFormDef is kept as the builder (not just its built form) because the
// columns-load meta rebuilds the dialog from it — schemaMap() / uiMap() give it a
// fresh copy to splice the discovered column fields into. See columnsEnvelope.
export const insertFormDef = formkit
  .form("Insert record")
  .describe(
    "Add a row to a table. Pick the table, press ↻ to load its columns as value fields, and fill the ones you want — or paste a JSON record below. ClickHouse INSERT has no upsert.",
  )
  .add(
    formkit
      .text("database", "Database")
      .describe("Optional, e.g. default. Empty uses the connection's database."),
    // One button does both steps: with the box empty it lists the tables to pick
    // from; once a table is set, pressing it again loads that table's columns as
    // the value fields below. See metaTablePick.
    formkit
      .text("table", "Table")
      .required()
      .describe(
        "The table to write to. Press ↻ with the box empty to list tables; pick one, then press ↻ again to load its columns as value fields below.",
      )
      .lookup("clickhouse.meta.table.pick", "Tables / columns"),
    formkit.textArea("record", "JSON record (optional)").describe(descInsertRecord),
  );

export const insertForm = insertFormDef.build();

export const createDatabaseForm = formkit
  .form("Create database (if not exists)")
  .describe("Create a database only if it does not already exist; an existing one is left untouched.")
  .add(
    formkit
      .text("database", "Database")
      .required()
      .describe("Identifier of the database to create, e.g. analytics. Accepts a {{$.path}} token."),
    formkit
      .text("engine", "Engine (optional)")
      .option("suggestion", databaseEngines)
      .describe(
        "Database engine. Pick a suggestion or type any engine ClickHouse supports; e.g. Atomic (the default), Memory, Lazy, Replicated. Leave empty for the server default.",
      ),
    formkit
      .text("comment", "Comment (optional)")
      .describe("A description stored with the database."),
  )
  .build();

export const createTableForm = formkit
  .form("Create table (if not exists)")
  .add(
    formkit
      .text("database", "Database")
      .describe(
        "Optional, e.g. default. Empty uses the connection's database. Used only with column definitions; ignored when you paste a full statement.",
      ),
    formkit
      .text("table", "Table name")
      .describe(
        "Identifier only, e.g. events. Required when the definition below is only columns; not needed when you paste a full CREATE TABLE statement.",
      ),
    formkit
      .textArea("columns", "Column definitions or full statement")
      .required()
      .describe(
        "Either a whole CREATE TABLE statement — CREATE TABLE events (event_id UInt64, severity String) ENGINE = MergeTree ORDER BY event_id — or just the column definitions that go inside the parentheses — event_id UInt64, severity String. This is SQL, not a JSON record. IF NOT EXISTS is applied for you.",
      ),
    formkit
      .text("engine", "Engine")
      .default("MergeTree")
      .option("suggestion", tableEngines)
      .describe(
        "Table engine, used only with bare column definitions (a full statement carries its own). Pick a suggestion or type any engine — including a parameterised one, e.g. ReplacingMergeTree(version). Common: MergeTree, ReplacingMergeTree, Log, Memory.",
      ),
    formkit
      .text("orderBy", "ORDER BY")
      .default("tuple()")
      .describe(
        "Sorting key, used only with bare column definitions and a *MergeTree engine. e.g. event_id, or (tenant, event_id). tuple() means unsorted.",
      ),
  )
  .build();
