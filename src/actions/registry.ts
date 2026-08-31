// Wires the ClickHouse client onto the plugin's node actions — a read, a write,
// an insert, and a create-table — plus the two meta RPCs the forms use (the
// settings "Test connection" button, and the Insert form's single button that
// lists a connection's tables and then loads the chosen table's columns as form
// fields). The Node port of the Postgres plugin's internal/actions package.

import {
  castRequestTo,
  formkit,
  type Action,
  type Job,
  type Meta,
  type Request,
  type Settings,
} from "@inflowenger/node-plugin-sdk";

import type { Client } from "../clickhouse/client.js";
import { Pool } from "../clickhouse/settings.js";
import {
  createDatabaseForm,
  createTableForm,
  executeForm,
  insertForm,
  insertFormDef,
  queryForm,
  settingsForm,
} from "./forms.js";
import { resolveInputVars, VarResolver } from "./vars.js";

// maxRowLimit is the ceiling on how many rows a read returns. A larger request
// is clamped to it rather than refused, and it is also the default.
const maxRowLimit = 100;

// One action's output. Returning it from a handler lets run() finish the job.
type Output = Record<string, unknown>;

// A handler is the pure work of one action over a ready client. Finishing the
// job is left to run(); throwing fails the node with the error's message.
type Handler = (
  job: Job,
  client: Client,
  input: Record<string, unknown>,
  resolver: VarResolver,
) => Promise<Output>;

/**
 * Registry owns what the actions share: the pool that turns each call's settings
 * profile into a client. The plugin holds no database configuration of its own.
 */
export class Registry {
  private readonly pool = new Pool();

  /** Every action this plugin exposes, in the order the canvas shows them. */
  all(): Action[] {
    return [
      this.query(),
      this.execute(),
      this.insert(),
      this.createDatabase(),
      this.createTable(),
    ];
  }

  /** The settings meta RPCs: test a connection, and list tables / load columns. */
  metas(): Meta[] {
    return [
      { method: "clickhouse.meta.ping.check", requestHandler: (req) => this.metaPingCheck(req) },
      { method: "clickhouse.meta.table.pick", requestHandler: (req) => this.metaTablePick(req) },
    ];
  }

  /** The settings profile: the form plus the submit handler that validates it. */
  settings(): Settings {
    return {
      ...settingsForm,
      submitHandler: async (req) => {
        const conn = connFrom(decodeMeta(req.data));
        let client: Client;
        try {
          client = this.pool.client(conn);
        } catch (e) {
          return { error: errText(e) };
        }
        try {
          await client.ping();
        } catch (e) {
          return { error: "connection test failed: " + errText(e) };
        }
        return { data: { ok: true, connectedTo: client.connInfo } };
      },
    };
  }

  /** The same form for PluginIntro.settings — the plugin set-up dialog reads it. */
  settingsForm() {
    return settingsForm;
  }

  // ------------------------------------------------------------- actions --

  private query(): Action {
    return {
      method: "clickhouse.query",
      title: "Run Query (read)",
      description:
        "Run a SELECT (or any row-returning statement) and get the rows back. Pull values from the flow inline with {{$.path}}, and bind typed values with named parameters. At most 100 rows are returned.",
      icon: { icon: "mdi-database-search" },
      form: queryForm,
      requestHandler: this.run("query", async (job, client, input) => {
        const sql = str(input.sql);
        if (sql === "") throw new Error("missing required input: sql");
        const params = parseParams(input.params);
        const limit = resolveLimit(str(input.limit));

        await job.progress(50, { title: "query", content: preview(sql) });

        const res = await client.query(sql, params, limit);
        return { columns: res.columns, rows: res.rows, rowCount: res.rowCount };
      }),
    };
  }

  private execute(): Action {
    return {
      method: "clickhouse.execute",
      title: "Execute (write / DDL)",
      description:
        "Run an INSERT / ALTER / DROP / TRUNCATE / DDL statement. Returns no rows — use the Query action to read. Bind typed values with named parameters and {{$.path}}.",
      icon: { icon: "mdi-database-edit" },
      form: executeForm,
      requestHandler: this.run("execute", async (job, client, input) => {
        const sql = str(input.sql);
        if (sql === "") throw new Error("missing required input: sql");
        const params = parseParams(input.params);

        await job.progress(50, { title: "execute", content: preview(sql) });

        const queryId = await client.command(sql, params);
        return { ok: true, queryId };
      }),
    };
  }

  private insert(): Action {
    return {
      method: "clickhouse.record.insert",
      title: "Insert record",
      description:
        "Write a row to a table from column fields or a JSON record. ClickHouse INSERT has no upsert — deduplication is a table-engine concern. Values accept {{$.path}} tokens.",
      icon: { icon: "mdi-table-row-plus-after" },
      form: insertForm,
      requestHandler: this.run("insert", async (job, client, input, resolver) => {
        const table = str(input.table);
        if (table === "") throw new Error("missing required input: table");

        const data = await insertData(input, resolver);
        if (Object.keys(data).length === 0) {
          throw new Error("no column values: fill in at least one column field, or a JSON record");
        }

        const database = str(input.database);
        const qualified = qualifiedName(database, table);

        await job.progress(50, { title: "insert", content: `into ${qualified}` });

        const queryId = await client.insertRows(qualified, [data]);
        const out: Output = { ok: true, table, rowsInserted: 1, queryId, row: data };
        if (database !== "") out.database = database;
        return out;
      }),
    };
  }

  private createDatabase(): Action {
    return {
      method: "clickhouse.database.create",
      title: "Create Database (if not exists)",
      description:
        "Create a database only if it does not already exist; an existing one is left untouched. Optionally set the engine and a comment.",
      icon: { icon: "mdi-database-plus" },
      form: createDatabaseForm,
      requestHandler: this.run("create database", async (job, client, input) => {
        const database = str(input.database);
        if (database === "") throw new Error("missing required input: database");

        const ddl = buildCreateDatabaseDDL(database, str(input.engine), str(input.comment));

        await job.progress(50, { title: "create database", content: preview(ddl) });

        const queryId = await client.command(ddl);
        return { ok: true, database, ddl, queryId };
      }),
    };
  }

  private createTable(): Action {
    return {
      method: "clickhouse.table.create",
      title: "Create Table (if not exists)",
      description:
        "Create a table only if it does not already exist. Give it either ClickHouse column definitions (with a table name, engine and ORDER BY) or a whole CREATE TABLE statement; existing tables are left untouched.",
      icon: { icon: "mdi-table-plus" },
      form: createTableForm,
      requestHandler: this.run("create table", async (job, client, input) => {
        const columns = str(input.columns);
        if (columns === "") throw new Error("missing required input: columns");

        const ddl = buildCreateDDL(
          str(input.database),
          str(input.table),
          columns,
          str(input.engine) || "MergeTree",
          str(input.orderBy) || "tuple()",
        );

        await job.progress(50, { title: "create table", content: preview(ddl) });

        let queryId: string;
        let createdDatabase = "";
        try {
          queryId = await client.command(ddl);
        } catch (e) {
          // If the target database does not exist, create it and retry once.
          // The name comes from the action's database field, the db. qualifier
          // in a full statement, or the connection's default — whichever is set.
          const database = str(input.database) || dbFromDDL(ddl) || client.database;
          if (!isUnknownDatabase(e) || database === "") throw e;

          await job.progress(70, { title: "create database", content: database });
          await client.command(buildCreateDatabaseDDL(database, "", ""));
          queryId = await client.command(ddl);
          createdDatabase = database;
        }

        const out: Output = { ok: true, ddl, queryId };
        if (createdDatabase !== "") out.createdDatabase = createdDatabase;
        // Report the table actually named in the DDL, not the stale form field:
        // when a whole CREATE TABLE statement is given, the `table` input is
        // ignored, so echoing it would mislabel the created table.
        const table = tableFromDDL(ddl) || str(input.table);
        if (table !== "") out.table = table;
        return out;
      }),
    };
  }

  // run adapts a handler into an SDK job handler: decode the typed body and the
  // connection that came with it, resolve the client, resolve {{$...}} tokens in
  // every string input, report progress, and terminate the job exactly once on
  // every path.
  private run(title: string, handler: Handler): (job: Job) => Promise<void> {
    return async (job: Job) => {
      let input: Record<string, unknown>;
      let settings: Record<string, unknown> | undefined;
      try {
        const req = castRequestTo<Record<string, unknown> & { settings?: Record<string, unknown> }>(
          job.req.data,
        );
        input = { ...(req.body ?? {}) };
        settings = (input.settings as Record<string, unknown>) ?? undefined;
        delete input.settings; // the connection travels separately, not as action input
      } catch (e) {
        await job.doneWithError("invalid request body: " + errText(e));
        return;
      }

      let client: Client;
      try {
        client = this.pool.client(settings);
      } catch (e) {
        await job.doneWithError(errText(e));
        return;
      }

      const resolver = new VarResolver(job);
      try {
        // Resolve {{$...}} tokens in every string input against the flow scope,
        // so the SQL, the parameters and the JSON record can reference upstream
        // data. Per-column insert values are nested, so insertData resolves
        // those with the same resolver.
        await resolveInputVars(job, input, resolver);

        await job.progress(20, { title, content: "on " + client.connInfo });

        const out = await handler(job, client, input, resolver);

        await job.progress(90, { title, content: "committing result" });
        await job.done(out ?? {});
      } catch (e) {
        await job.doneWithError(errText(e));
      }
    };
  }

  // --------------------------------------------------------------- metas --

  // metaPingCheck backs the settings form's "Test connection" button and its
  // submit validation. It opens the connection being edited and pings it, so a
  // wrong host or password is reported in the dialog instead of failing every
  // node later.
  private async metaPingCheck(req: Request): Promise<unknown> {
    const conn = connFrom(decodeMeta(req.data));
    let client: Client;
    try {
      client = this.pool.client(conn);
    } catch (e) {
      return formkit.failure("%s", errText(e)).patch(null);
    }
    try {
      await client.ping();
    } catch (e) {
      return formkit.failure("cannot reach %s: %s", client.connInfo, errText(e)).patch(null);
    }
    // A patch with nothing but a message: the test writes no value into the
    // profile, and saying what it found is the whole point of the button.
    return formkit.success("Connected to %s.", client.connInfo).patch(null);
  }

  // metaTablePick backs the Insert form's single "Tables / columns" button. It
  // reads what the Table box holds (posted as `value`) and branches:
  //
  //   - empty box → list the connection's tables, rebuilding Table as a drop-down;
  //   - a table set → load that table's columns and re-render the form with a
  //     value field per column (see columnsEnvelope).
  //
  // A name that matches no table falls through to the list, so a typo just shows
  // the choices. Either branch is a whole-form answer, not a patch, because the
  // options and the column fields did not exist when the plugin was compiled.
  private async metaTablePick(req: Request): Promise<unknown> {
    const call = decodeMeta(req.data);
    const settings = (call.settings as Record<string, unknown>) ?? undefined;
    let client: Client;
    try {
      client = this.pool.client(settings);
    } catch (e) {
      return formkit.failure("%s", errText(e)).patch(null);
    }

    const database = str(call.database);
    const table = str(call.value) || str(call.table);

    // A table already chosen: load its columns and re-render with a value field
    // for each. A name matching nothing falls through to the table list below.
    if (table !== "") {
      try {
        const res = await client.query(columnsSQL, { t: table, db: database }, 0);
        if (res.rows.length > 0) {
          return columnsEnvelope(res.rows, formkit.formData(call));
        }
      } catch (e) {
        return formkit.failure("cannot read columns of %s: %s", table, errText(e)).about("table").patch(null);
      }
    }

    let tables;
    try {
      tables = await client.query(tablesSQL, { db: database }, 0);
    } catch (e) {
      return formkit.failure("cannot list tables: %s", errText(e)).patch(null);
    }

    const options = tables.rows.map((row) => ({
      value: String(row.name ?? ""),
      label: `${String(row.database ?? "")}.${String(row.name ?? "")}`,
    }));
    if (options.length === 0) {
      return formkit.warning("no tables found on %s — check the database", client.connInfo).about("table").patch(null);
    }

    const heading =
      table !== ""
        ? formkit.warning("no table %s on %s — pick one below, then press ↻ again for its columns", table, client.connInfo)
        : formkit.success("%s tables on %s — pick one, then press ↻ again to load its columns", options.length, client.connInfo);

    return formkit.choose(insertForm, "table", options, formkit.formData(call), heading);
  }
}

// ---------------------------------------------------------------- SQL --

// SQL behind the Insert form's lookup. Both filter by an optional database — the
// empty string, the default, matches every user database — and both leave the
// system databases out so the picker shows only what a person would write to.
const tablesSQL = `SELECT database, name
FROM system.tables
WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
  AND NOT is_temporary
  AND ({db:String} = '' OR database = {db:String})
ORDER BY database, name`;

const columnsSQL = `SELECT name, type
FROM system.columns
WHERE table = {t:String}
  AND ({db:String} = '' OR database = {db:String})
ORDER BY position`;

// ---------------------------------------------------------------- insert --

// insertData turns the action's two input shapes into the column → value map to
// write. A JSON record wins when present; otherwise the loaded column fields are
// used, with each value resolved and typed the way a query value would be.
async function insertData(
  input: Record<string, unknown>,
  resolver: VarResolver,
): Promise<Record<string, unknown>> {
  // A pasted record. Its {{$.path}} tokens were resolved by run() before it
  // reached here, since record is a plain string field, so it now parses as
  // ordinary JSON.
  const rec = str(input.record);
  if (rec !== "") {
    let obj: unknown;
    try {
      obj = JSON.parse(rec);
    } catch (e) {
      throw new Error("JSON record does not parse as an object: " + errText(e));
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new Error("JSON record must be a JSON object of column → value");
    }
    return obj as Record<string, unknown>;
  }

  // Column fields. run()'s walk rewrites top-level strings, but not the values
  // inside this nested map, so resolve them here with the shared resolver. A
  // blank column is omitted so the column's default applies.
  const values = (input.values as Record<string, unknown>) ?? {};
  const data: Record<string, unknown> = {};
  for (const [col, raw] of Object.entries(values)) {
    if (typeof raw !== "string") {
      if (raw !== null && raw !== undefined) data[col] = raw;
      continue;
    }
    const resolved = (await resolver.resolve(raw)).trim();
    if (resolved === "") continue;
    data[col] = coerceParam(resolved);
  }
  return data;
}

// ------------------------------------------------------------ create table --

// createTableRe matches the head of a CREATE TABLE statement up to the table
// name — so a whole statement can be told apart from a bare column list.
const createTableRe = /^\s*CREATE\s+TABLE\s+/i;
// ifNotExistsRe recognises a statement that is already idempotent, so the clause
// is never inserted twice.
const ifNotExistsRe = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i;

// buildCreateDDL turns the form input into the statement to run. Two shapes are
// accepted: a whole CREATE TABLE statement (run as given, with IF NOT EXISTS
// spliced in and a trailing semicolon trimmed), or bare column definitions
// wrapped as CREATE TABLE IF NOT EXISTS <table> (...) ENGINE = <engine> [ORDER
// BY <orderBy>]. ORDER BY is added only for a *MergeTree engine, which is the
// family that requires one.
function buildCreateDDL(
  database: string,
  table: string,
  columns: string,
  engine: string,
  orderBy: string,
): string {
  if (createTableRe.test(columns)) {
    let ddl = columns.replace(/[\s;]+$/, "");
    if (!ifNotExistsRe.test(ddl)) {
      ddl = ddl.replace(createTableRe, "CREATE TABLE IF NOT EXISTS ");
    }
    return ddl;
  }

  if (table === "") {
    throw new Error(
      "missing required input: table (needed when the definition is only columns, not a full CREATE TABLE statement)",
    );
  }
  const ident = qualifiedName(database, table);
  let ddl = `CREATE TABLE IF NOT EXISTS ${ident} (${columns}) ENGINE = ${engine}`;
  if (/MergeTree/i.test(engine) && orderBy !== "") {
    ddl += ` ORDER BY ${orderBy}`;
  }
  return ddl;
}

// createTableHeadRe parses the head of a CREATE TABLE statement — the optional
// IF NOT EXISTS clause and backtick quoting are stripped. Group 1 is the db.
// qualifier when present, group 2 the table name.
const createTableHeadRe =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?([^`.\s(]+)`?\.)?`?([^`.\s(]+)`?/i;

// tableFromDDL reports the table actually named in a CREATE TABLE statement, so
// the output is not mislabelled by a stale form field. "" when it does not parse.
function tableFromDDL(ddl: string): string {
  return ddl.match(createTableHeadRe)?.[2] ?? "";
}

// dbFromDDL reports the database qualifier written into a CREATE TABLE statement
// (the "db" in `CREATE TABLE db.t`), or "" when the name is unqualified.
function dbFromDDL(ddl: string): string {
  return ddl.match(createTableHeadRe)?.[1] ?? "";
}

// buildCreateDatabaseDDL renders CREATE DATABASE IF NOT EXISTS with an optional
// engine and comment. The name is identifier-quoted; the comment is bound as a
// literal (single quotes doubled), never spliced raw.
function buildCreateDatabaseDDL(database: string, engine: string, comment: string): string {
  let ddl = `CREATE DATABASE IF NOT EXISTS ${quoteIdent(database)}`;
  if (engine !== "") ddl += ` ENGINE = ${engine}`;
  if (comment !== "") ddl += ` COMMENT '${comment.replace(/'/g, "''")}'`;
  return ddl;
}

// isUnknownDatabase tells whether a failed command failed because its target
// database does not exist — ClickHouse error code 81 / type UNKNOWN_DATABASE —
// so the create-table action can create it and retry. The message is matched
// too, in case the error was not parsed into the structured shape.
function isUnknownDatabase(e: unknown): boolean {
  if (e && typeof e === "object") {
    const { code, type } = e as { code?: unknown; type?: unknown };
    if (type === "UNKNOWN_DATABASE" || code === "81") return true;
  }
  return /UNKNOWN_DATABASE|Database\b.*(?:does ?n['’]?t|does not) exist/i.test(errText(e));
}

// -------------------------------------------------------------- form envelope --

// columnsEnvelope rebuilds the Insert dialog with a value field per column. It
// starts from the form's own schema and layout (a fresh copy from the builder),
// adds a `values` object whose properties are the columns, and drops a control
// for each into a "Column values" group placed just above the JSON-record field.
// The returned map carries only envelope keys, which is what tells the host to
// re-render the dialog rather than patch a single field.
function columnsEnvelope(rows: Record<string, unknown>[], data: Record<string, unknown>): Record<string, unknown> {
  const schema = insertFormDef.schemaMap();
  const ui = insertFormDef.uiMap();

  const valueProps: Record<string, unknown> = {};
  const controls: unknown[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const col = typeof row.name === "string" ? row.name : "";
    if (col === "" || seen.has(col)) continue;
    seen.add(col);
    const dataType = typeof row.type === "string" ? row.type : "";
    valueProps[col] = {
      type: "string",
      title: col,
      description: `${dataType} — a literal or a {{$.path}} token; blank to use the default`.trim(),
    };
    controls.push({ type: "Control", scope: "#/properties/values/properties/" + col });
  }

  const props = schema.properties as Record<string, unknown> | undefined;
  if (props) {
    props.values = { type: "object", title: "Column values", properties: valueProps };
  }

  const group = { type: "Group", label: "Column values", elements: controls };
  const elements = ui.elements as unknown[] | undefined;
  if (elements) {
    ui.elements = insertBefore(elements, "#/properties/record", group);
  }

  return {
    schema,
    uischema: ui,
    data,
    [formkit.NotifKey]: formkit.success("Loaded %s columns — fill the ones you want", controls.length).about("table"),
  };
}

// insertBefore splices an element into a UI Schema's element list just ahead of
// the control at the given scope, appending it if that control is not found.
function insertBefore(elements: unknown[], scope: string, element: unknown): unknown[] {
  const out: unknown[] = [];
  let inserted = false;
  for (const el of elements) {
    if (!inserted && el && typeof el === "object" && (el as Record<string, unknown>).scope === scope) {
      out.push(element);
      inserted = true;
    }
    out.push(el);
  }
  if (!inserted) out.push(element);
  return out;
}

// ---------------------------------------------------------------- helpers --

// parseParams reads the Parameters field — an optional JSON object of the named
// parameters the SQL references as {name:Type}. Each value keeps its JSON type,
// so it is bound as the right ClickHouse type by the {name:Type} placeholder.
function parseParams(raw: unknown): Record<string, unknown> | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "") return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch (e) {
    throw new Error("Parameters must be a JSON object: " + errText(e));
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("Parameters must be a JSON object of name → value");
  }
  return obj as Record<string, unknown>;
}

// coerceParam reads one column-value string for an insert. A clean JSON value
// wins (42 an integer, true a boolean, null the SQL NULL, {"k":1} an object);
// otherwise the raw string is the value — a bare word, an e-mail, a zero-padded
// code like 007. To force a value to stay a string, quote it: "42".
function coerceParam(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === "") return s;
  try {
    return JSON.parse(trimmed);
  } catch {
    return s;
  }
}

// resolveLimit turns the (already {{$.path}}-resolved) limit field into the row
// cap to apply. Empty means the default; anything over the ceiling is clamped to
// it. A non-number is an error, since it is almost always an unresolved token.
function resolveLimit(raw: string): number {
  const s = raw.trim();
  if (s === "") return maxRowLimit;
  const n = Number(s);
  if (!Number.isInteger(n)) {
    throw new Error(`max rows must be a whole number up to ${maxRowLimit}: ${JSON.stringify(s)}`);
  }
  if (n <= 0 || n > maxRowLimit) return maxRowLimit;
  return n;
}

// quoteIdent backtick-quotes a ClickHouse identifier, escaping backslashes and
// backticks — so a name it cannot represent safely is rejected rather than
// injected. Values are never quoted this way; they are bound as parameters.
function quoteIdent(name: string): string {
  return "`" + name.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
}

// qualifiedName renders db.table (or just table), each identifier quoted.
function qualifiedName(database: string, table: string): string {
  return database !== "" ? `${quoteIdent(database)}.${quoteIdent(table)}` : quoteIdent(table);
}

// preview trims SQL to one short line for a progress frame.
function preview(sql: string): string {
  const one = sql.split(/\s+/).filter(Boolean).join(" ");
  return one.length > 120 ? one.slice(0, 117) + "…" : one;
}

// connFrom pulls the profile values out of a meta/submit call. On an action's
// drawer the bound profile is under "settings"; the set-up dialog has no bound
// profile and sends the edited values at the top level, alongside host keys.
function connFrom(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.settings;
  if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
    return nested as Record<string, unknown>;
  }
  const conn = { ...body };
  for (const hostKey of ["settings", "value", "targetField", "form"]) delete conn[hostKey];
  return conn;
}

// decodeMeta reads a meta RPC's arguments, tolerating the {_registry, body}
// envelope or a bare object, and treating anything unreadable as "no arguments".
function decodeMeta(data: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(data).trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed.body === "object" && parsed.body !== null) {
      return parsed.body as Record<string, unknown>;
    }
    return parsed;
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
