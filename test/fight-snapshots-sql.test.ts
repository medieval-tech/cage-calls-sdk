import { describe, expect, it } from "vitest";

import { MAINNET_PRESET, createCageCallsClient } from "../src/index.js";
import { createMockRpcTransport } from "../src/testing/index.js";
import { readU128Sum, sqlText, sqlU128Sum } from "../src/transports/torii-sql.js";
import { createToriiWithSql, toriiSql } from "./torii-sqlite.js";

const connection = (nodes: Record<string, unknown>[]) => ({
  edges: nodes.map((node, index) => ({ cursor: `row-${index}`, node })),
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, ...(nodes.length ? { endCursor: `row-${nodes.length - 1}` } : {}) },
});

const fightRow = (fightId: string, marketId: string) => ({
  fight_id: fightId, season_id: "1", event: "main-card", market_id: marketId,
  fighter_a_id: "1", fighter_a_name: "A", fighter_a_weight_class: "Lightweight", choice_a_value: "1", choice_a_label: "A",
  fighter_b_id: "2", fighter_b_name: "B", fighter_b_weight_class: "Lightweight", choice_b_value: "2", choice_b_label: "B",
  created_at: "1700000000", is_dev: false, sponsor: "0",
});

const marketRow = (marketId: string, conditionId: string) => ({
  market_id: marketId, creator: "0x1", created_at: "1700000000", question_id: "3", condition_id: conditionId, oracle: "0x5",
  outcome_slot_count: "2", collateral_token: MAINNET_PRESET.contracts.CALLS, start_at: "10", end_at: "1600000000",
  resolve_at: "1600000100", resolved_at: "1700001000",
});

const STAKE = 1_000_000_000_000_000_000n;
const buy = (fightId: string, buyer: string, choice: number, amount: bigint, boughtAt: number) => ({
  fight_id: fightId, buyer, market_id: fightId === "84" ? "900" : "901", choice_index: String(choice), amount: amount.toString(), bought_at: String(boughtAt),
});

describe("Torii SQL u256 sums", () => {
  it("sums every 16-bit chunk exactly and rejects values of 2^128 or more", () => {
    const max128 = (1n << 128n) - 1n;
    const sql = toriiSql({ FightBuy: [buy("1", "0xa", 0, max128, 1), buy("1", "0xb", 0, max128, 2), buy("1", "0xc", 0, 0x1234_5678_9abc_def0n, 3)] });
    const [row] = sql(`SELECT ${sqlU128Sum("amount", "s")} FROM "pm-FightBuy"`);
    expect(readU128Sum(row ?? {}, "s")).toBe(max128 * 2n + 0x1234_5678_9abc_def0n);

    const wide = toriiSql({ FightBuy: [buy("1", "0xa", 0, 1n << 128n, 1)] });
    const [wideRow] = wide(`SELECT ${sqlU128Sum("amount", "s")} FROM "pm-FightBuy"`);
    expect(() => readU128Sum(wideRow ?? {}, "s")).toThrow(/2\^128/);
  });

  it("quotes text literals", () => {
    const sql = toriiSql({ Fight: [{ fight_id: "1", event: "Joe's Night" }] });
    expect(sql(`SELECT fight_id FROM "pm-Fight" WHERE event = ${sqlText("Joe's Night")}`)).toHaveLength(1);
  });
});

describe("fight snapshots from Torii SQL aggregates", () => {
  // Fight 84 is legacy (below the cutover), fight 120 pays locked odds.
  const viewer = "0xabc";
  const buys = [
    // Legacy: winner shares 2 + 2 + 3 over a 10-token pot. Two 2-share winners redeemed:
    // each claim rounds down on its own (2 * 10 / 7 = 2), so claimed is 4, not 40 / 7 = 5.
    buy("84", viewer, 1, 2n, 1_700_000_100),
    buy("84", "0xb", 1, 2n, 1_700_000_100),
    buy("84", "0xc", 1, 3n, 1_700_000_200),
    buy("84", "0xd", 0, 5n, 1_700_000_050),
    // Locked odds: two buys in the same second replay in chain (fixture) order.
    buy("120", viewer, 0, 7n * STAKE, 1_700_000_300),
    buy("120", "0xe", 1, 9n * STAKE, 1_700_000_300),
  ];
  const winners = [
    { fight_id: "84", winner: viewer, choice_index: "1", redeemed: true },
    { fight_id: "84", winner: "0xb", choice_index: "1", redeemed: true },
    { fight_id: "84", winner: "0xc", choice_index: "1", redeemed: false },
    { fight_id: "120", winner: viewer, choice_index: "0", redeemed: false },
  ];
  const fightBuyWheres: Array<Record<string, unknown>> = [];
  const torii = createToriiWithSql({
    models: {
      Fight: (request) => {
        const wanted = (request.where as { fight_idIN?: string[] } | undefined)?.fight_idIN;
        const rows = [fightRow("120", "901"), fightRow("84", "900")];
        return connection(wanted ? rows.filter((row) => wanted.some((id) => BigInt(id) === BigInt(row.fight_id))) : rows);
      },
      Market: connection([marketRow("900", "4"), marketRow("901", "5")]),
      VaultNumerator: connection([
        { market_id: "901", index: "0", value: (10n * STAKE).toString() },
        { market_id: "901", index: "1", value: (12n * STAKE).toString() },
      ]),
      VaultDenominator: connection([{ market_id: "901", value: (22n * STAKE).toString() }]),
      FightBuy: (request) => {
        const where = (request.where ?? {}) as Record<string, unknown>;
        fightBuyWheres.push(where);
        return connection(buys.filter((row) => row.buyer === where.buyerEQ));
      },
      FightWinner: (request) => {
        const where = (request.where ?? {}) as Record<string, unknown>;
        return connection(winners.filter((row) => row.winner === where.winnerEQ));
      },
      PayoutNumerator: connection([
        { condition_id: "4", index: "0", value: "0" },
        { condition_id: "4", index: "1", value: "1" },
        { condition_id: "5", index: "0", value: "1" },
        { condition_id: "5", index: "1", value: "0" },
      ]),
      PayoutDenominator: connection([{ condition_id: "4", value: "1" }, { condition_id: "5", value: "1" }]),
    },
    tables: {
      FightBuy: buys,
      FightWinner: winners,
      MarketBuy: [
        { market_id: "900", account_address: MAINNET_PRESET.contracts.FightFactory, amount_in: "6" },
        { market_id: "900", account_address: MAINNET_PRESET.contracts.FightFactory, amount_in: "4" },
        { market_id: "901", account_address: MAINNET_PRESET.contracts.FightFactory, amount_in: (16n * STAKE).toString() },
      ],
    },
  });
  const rpc = createMockRpcTransport({ calls: { locked_odds_cutover: ["0x64", "0x0"] } });
  const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

  it("computes exact aggregates for every fight without reading other accounts' rows", async () => {
    const response = await client.fights.feedAll({ viewer });

    expect(response.meta).toMatchObject({ source: "torii", complete: true });
    expect(response.data.map((fight) => fight.fightId)).toEqual([120n, 84n]);
    expect(fightBuyWheres.every((where) => where.buyerEQ === viewer)).toBe(true);

    const [locked, legacy] = response.data;
    expect(legacy).toMatchObject({
      lockedOdds: false,
      outcomeCounts: [1n, 3n],
      outcomeShares: [5n, 7n],
      pot: { total: 10n, claimed: 4n, winnerIndex: 1, winnersCount: 3n, settled: true },
      viewer: { hasBought: true, choiceIndex: 1, shares: 2n, isWinner: true, hasRedeemed: true },
    });
    expect(locked).toMatchObject({
      lockedOdds: true,
      outcomeCounts: [1n, 1n],
      outcomeShares: [7n * STAKE, 9n * STAKE],
      // Locked odds burn the whole pot at settle.
      pot: { total: 16n * STAKE, claimed: 16n * STAKE, winnerIndex: 0, winnersCount: 1n, settled: true },
      viewer: { hasBought: true, choiceIndex: 0, isWinner: true, hasRedeemed: false, previewStrikeTickets: 7n },
    });
    // Seed point, then the same-second buys in chain order: choice 0 first, then choice 1.
    expect(locked?.oddsSeries?.map((point) => point.numerators)).toEqual([
      [9n * STAKE, 11n * STAKE],
      [10n * STAKE, 11n * STAKE],
      [10n * STAKE, 12n * STAKE],
    ]);
  });
});
