// A ready-to-use ClickHouse client for one connection. The three halves of the
// plugin — reading rows, running a statement, and inserting records — each go
// through `@clickhouse/client`, which speaks the HTTP interface. Values are
// bound as ClickHouse named parameters ({name:Type}), never spliced into SQL.
//
// The Node counterpart of the Postgres plugin's internal/postgres/client.go.

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import type { Config } from "./settings.js";

/** Result is what a read returns: the column names in order, and the rows. */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

// The shape ClickHouse returns for the JSON output format: column metadata plus
// the rows, so a read can report the column order the server used.
interface ClickHouseJSON {
  meta?: { name: string; type: string }[];
  data?: Record<string, unknown>[];
}

export class Client {
  private readonly ch: ClickHouseClient;
  /** host:port/database — no credentials in it. */
  readonly connInfo: string;
  /** The connection's default database — "" when none was configured. */
  readonly database: string;

  constructor(cfg: Config) {
    this.ch = createClient({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      database: cfg.database || undefined,
      request_timeout: cfg.requestTimeoutMs,
      application: "inflow-clickhouse-plugin",
      // Keep the HTTP connection alive under a long-running query: the server
      // trickles progress headers so an idle load balancer does not drop the
      // socket before the result arrives. The interval stays under the request
      // timeout above.
      clickhouse_settings: {
        send_progress_in_http_headers: 1,
        http_headers_progress_interval_ms: "50000",
      },
    });
    this.connInfo = cfg.connInfo;
    this.database = cfg.database;
  }

  /** Close releases the client. Called when it is evicted from the pool cache. */
  async close(): Promise<void> {
    await this.ch.close();
  }

  /** Ping verifies the connection is live, for the "Test connection" button. */
  async ping(): Promise<void> {
    const res = await this.ch.ping();
    if (!res.success) throw res.error;
  }

  /**
   * Query runs a row-returning statement and reads its rows. `params` are bound
   * as ClickHouse named parameters referenced as {name:Type} in the SQL.
   * `maxRows` caps how many rows the server returns (0 means no cap) via
   * max_result_rows with result_overflow_mode=break, so a large SELECT is
   * trimmed rather than refused.
   */
  async query(
    sql: string,
    params: Record<string, unknown> | undefined,
    maxRows: number,
  ): Promise<QueryResult> {
    const clickhouse_settings: Record<string, string> = {};
    if (maxRows > 0) {
      clickhouse_settings.max_result_rows = String(maxRows);
      clickhouse_settings.result_overflow_mode = "break";
    }

    const rs = await this.ch.query({
      query: sql,
      format: "JSON",
      query_params: params,
      clickhouse_settings,
    });

    const body = (await rs.json()) as ClickHouseJSON;
    const columns = (body.meta ?? []).map((m) => m.name);
    const rows = body.data ?? [];
    return { columns, rows, rowCount: rows.length };
  }

  /**
   * Command runs a statement that returns no rows — INSERT … SELECT, ALTER,
   * DROP, TRUNCATE, or any DDL. `params` bind {name:Type} placeholders. It
   * resolves to the server-assigned query id.
   */
  async command(sql: string, params?: Record<string, unknown>): Promise<string> {
    const res = await this.ch.command({
      query: sql,
      query_params: params,
    });
    return res.query_id;
  }

  /**
   * InsertRows writes rows to a table with the client's native insert path
   * (JSONEachRow), which handles type coercion and escaping — no VALUES string
   * is built. `table` is already identifier-quoted by the caller.
   */
  async insertRows(table: string, rows: Record<string, unknown>[]): Promise<string> {
    const res = await this.ch.insert({
      table,
      values: rows,
      format: "JSONEachRow",
    });
    return res.query_id;
  }
}
