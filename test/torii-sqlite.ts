import initSqlJs from "sql.js";

import { createMockToriiTransport } from "../src/testing/index.js";
import type { ToriiConnection } from "../src/transports/index.js";

// Torii's SQL layout for fixtures, so tests run the SDK's real SQL: a "pm-<Model>" table per
// model (Torii's own tables, such as "tokens", keep their lowercase name), felts/addresses/u256
// stored as 0x + 64 hex digits, u8/bool as integers, other values as text, and
// internal_event_id rising in fixture order like chain order.
const INTEGER_COLUMNS = new Set(["choice_index", "outcome_index", "index", "redeemed", "is_dev"]);
const MODEL_COLUMNS: Record<string, readonly string[]> = {
  FightBuy: ["fight_id", "buyer", "market_id", "choice_index", "amount", "bought_at"],
  FightWinner: ["fight_id", "winner", "choice_index", "redeemed"],
  MarketBuy: ["market_id", "outcome_index", "account_address", "amount", "amount_in"],
  tokens: ["id", "contract_address", "token_id", "metadata"],
};

function stored(column: string, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (INTEGER_COLUMNS.has(column)) return Number(value);
  if (typeof value === "bigint" || typeof value === "number" || (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value))) {
    return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  }
  return String(value);
}

const SQL = await initSqlJs();

export type ToriiTables = Record<string, readonly Record<string, unknown>[]>;

export function toriiSql(tables: ToriiTables): (statement: string) => Record<string, unknown>[] {
  const db = new SQL.Database();
  let eventId = 0;
  for (const [model, rows] of Object.entries({ FightBuy: [], FightWinner: [], MarketBuy: [], ...tables })) {
    const columns = Array.from(new Set([...(MODEL_COLUMNS[model] ?? []), ...rows.flatMap((row) => Object.keys(row))]));
    const definitions = ["internal_event_id TEXT", ...columns.map((column) => `"${column}" ${INTEGER_COLUMNS.has(column) ? "INTEGER" : "TEXT"}`)];
    const table = /^[A-Z]/.test(model) ? `pm-${model}` : model;
    db.run(`CREATE TABLE "${table}" (${definitions.join(", ")})`);
    for (const row of rows) {
      eventId += 1;
      db.run(`INSERT INTO "${table}" VALUES (${definitions.map(() => "?").join(", ")})`, [
        `0x${eventId.toString(16).padStart(16, "0")}`,
        ...columns.map((column) => stored(column, row[column])),
      ]);
    }
  }
  return (statement) => {
    const query = db.prepare(statement);
    const rows: Record<string, unknown>[] = [];
    while (query.step()) rows.push(query.getAsObject());
    query.free();
    return rows;
  };
}

type MockToriiInput = NonNullable<Parameters<typeof createMockToriiTransport>[0]>;

/** The mock Torii transport with SQL served from its static model fixtures plus any extra `tables`. */
export function createToriiWithSql(input: MockToriiInput & { tables?: ToriiTables } = {}) {
  const fromModels = Object.fromEntries(Object.entries(input.models ?? {}).flatMap(([model, value]) =>
    value && typeof value === "object" && "edges" in value
      ? [[model, (value as ToriiConnection<Record<string, unknown>>).edges.map((edge) => edge.node)]]
      : []));
  return createMockToriiTransport({ ...input, sql: toriiSql({ ...fromModels, ...input.tables }) });
}
