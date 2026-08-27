# Inflowenger ClickHouse plugin

A ClickHouse node for the Inflowenger workflow canvas, built on
[`@inflowenger/node-plugin-sdk`](https://github.com/Inflowenger/node-plugin-sdk)
under the **inflowv1** protocol. It runs as a long-running Node process and is
called by the Fractal runtime over NATS.

The plugin holds **no** database configuration. A connection travels in every
call as a settings profile (`body.settings`), so one running plugin serves many
ClickHouse servers and rotating a password needs no redeploy. It is the Node
counterpart of the Go [Postgres plugin](../postgres).

## Actions

| Action | Method | What it does |
| --- | --- | --- |
| **Run Query (read)** | `clickhouse.query` | Runs a SELECT (or any row-returning statement) and returns the rows, their column order, and a count. Pull values from the flow inline with `{{$.path}}`; bind typed values with named parameters. Returns **at most 100 rows**. |
| **Execute (write / DDL)** | `clickhouse.execute` | Runs an INSERT / ALTER / DROP / TRUNCATE / OPTIMIZE / DDL statement and returns the server query id. Returns no rows — use Query to read. |
| **Insert record** | `clickhouse.record.insert` | Writes a row to a table from per-column fields or a JSON record, using the client's native insert path. ClickHouse has **no upsert** (see below). |
| **Create Table (if not exists)** | `clickhouse.table.create` | Creates a table only when it does not already exist; existing tables are left untouched. |

## Run Query (read)

A **SQL** field, an optional **Parameters** object, and a **Max rows** field.
Pull values from the flow inline with `{{$.path}}`:

```sql
SELECT event_id, name FROM events WHERE tenant = '{{$.trigger.tenantId}}'
```

**Max rows** is capped at **100**: leave it blank for the default of 100, and
any larger number (or a `{{$.path}}` token that resolves to one) is treated as
100. The cap is enforced server-side with `max_result_rows` +
`result_overflow_mode = 'break'`.

## Parameters — bind values, safely

Never string-concatenate user input into SQL. ClickHouse uses **named,
typed** placeholders — `{name:Type}` — bound from the **Parameters** field, a
JSON object:

```sql
SELECT id, email FROM users WHERE org_id = {org:UInt64} AND active = {active:Bool}
```

```json
{ "org": 42, "active": true }
```

Each value keeps its JSON type, and the `{name:Type}` placeholder tells
ClickHouse how to bind it. A value may be a `{{$.path}}` token:

```json
{ "orderId": "{{$.trigger.orderId}}" }
```

The same field is available on **Execute**, so parameterised writes work the
same way:

```sql
ALTER TABLE orders UPDATE status = {status:String} WHERE id = {id:UInt64}
```

## Insert record

Write one row to a table, given one of two ways:

- **Per-column fields.** The **Table** field has a single ↻ *Tables / columns*
  button: press it with the box empty to list the tables, pick one, then press
  it again to load that table's columns (with their types) as value fields. Fill
  the ones you want; each accepts a literal or a `{{$.path}}` token, and a blank
  column is omitted so its default applies. A value that parses as JSON keeps its
  type (`42` an integer, `true` a boolean); anything else is text.
- **A JSON record.** Paste a `{ "column": value }` object into **JSON record**;
  it wins over the column fields when present. Values may be `{{$.path}}` tokens:
  ```json
  { "event_id": 7, "severity": "high", "name": "{{$.event.title}}" }
  ```

The row is written with the client's native `JSONEachRow` insert path.

### No upsert

Unlike Postgres, **ClickHouse `INSERT` has no `ON CONFLICT` / upsert.**
Duplicate keys are not rejected or merged at insert time — deduplication is a
property of the **table engine** and happens later, at merge time (e.g.
`ReplacingMergeTree`, `CollapsingMergeTree`). Choose the engine for the
semantics you need when you create the table.

## Create Table

The definition field accepts **ClickHouse SQL** in either shape:

- **A whole `CREATE TABLE` statement** (what most people paste):
  ```sql
  CREATE TABLE events (
      event_id  UInt64,
      severity  String,
      name      String,
      created_at DateTime
  )
  ENGINE = MergeTree
  ORDER BY event_id;
  ```
  Run as given; the table-name / engine / ORDER BY fields are not needed.
- **Just the column definitions** — the text inside the parentheses — with the
  table name, **Engine** and **ORDER BY** supplied separately:
  ```
  event_id UInt64, severity String, name String
  ```
  Wrapped as `CREATE TABLE IF NOT EXISTS <table> (...) ENGINE = <engine> ORDER BY
  <orderBy>`. `ORDER BY` is added only for a `*MergeTree` engine (the family that
  requires one); the default engine is `MergeTree` and the default sort key is
  `tuple()` (unsorted).

Either way `IF NOT EXISTS` is applied, so an existing table is left untouched.
Creating a table makes it **empty** — inserting rows is the Insert or Execute
action's job.

## `{{JSONPATH}}` — pull values from the flow

Any string input — the SQL text, the Parameters object, the JSON record, and
each column value — is resolved against the flow scope before it runs. Write
`{{$.path}}` and the runtime substitutes the value from upstream nodes. A token
the scope can't supply is left verbatim rather than silently dropped. Each
distinct path is fetched from the runtime once per call, however many fields
reference it.

## Connection (settings profile)

The plugin's set-up form asks for either a full connection URL **or** the
discrete fields:

- **Connection URL** — `http://host:8123` (or `https://host:8443` for TLS), the
  ClickHouse HTTP interface. Given, it wins.
- **Host / Port / Database / User / Password / Secure (HTTPS)** — used when no
  URL is set. Port defaults to `8123` (or `8443` when Secure is on); user
  defaults to `default`.

Press **Test connection** (↻) to ping the live server before saving. Keys are
matched leniently (case, spaces, dashes and underscores are ignored, plus the
usual synonyms), so a hand-typed profile still resolves.

## Running

Provisioning is a prerequisite: the plugin must be defined in a space to get
`PLUGIN_ID`, `INFRA_CRED` (base64) and `INFRA_URL`. Put them in `.env.inflow`
(see `.env.inflow.example`) — **ClickHouse credentials never go here**, they are
a settings profile.

```sh
npm install
npm run build
npm start        # node dist/main.js
# or, during development, run the TypeScript directly:
npm run dev      # tsx src/main.ts
```

The SDK logs each subscribed subject on startup. Add the node to a flow, bind a
settings profile, and run it.

## Layout

```
src/main.ts                 wiring: intro, settings, actions, block after start()
src/clickhouse/             settings profile → @clickhouse/client → query / command / insert / ping
src/actions/                the four actions, the {{JSONPATH}} resolver, forms, the table/column + connection-test metas
```

## Requirements

- **Node 20+** (required by `@clickhouse/client`).
- A reachable Inflowenger platform (Infra + at least one Fractal).
- A reachable ClickHouse server (HTTP interface, default port 8123 / 8443).
