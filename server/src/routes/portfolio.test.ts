import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real router + real sqlite in a throwaway DATA_DIR, served on an ephemeral
// loopback port (works under `docker run --network none`).
let dir: string;
let server: Server;
let base: string;
let closeDb: () => void;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ot-portfolio-test-"));
  process.env.DATA_DIR = dir;
  const express = (await import("express")).default;
  const { portfolioRouter } = await import("./portfolio.js");
  const { db } = await import("../db.js");
  closeDb = () => db.close();
  const app = express();
  app.use(express.json());
  app.use("/p", portfolioRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/p`;
});

afterAll(() => {
  server.close();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const post = (path: string, body: string | object) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const tx = (side: string, quantity: number, at: string, symbol = "AAPL") => ({
  symbol, side, quantity, price: 10, executed_at: at,
});

async function newPortfolio(name: string): Promise<number> {
  return (await (await post("", { name })).json()).id;
}

describe("transaction validation", () => {
  it("rejects a quantity that JSON-parses to Infinity (1e400)", async () => {
    const id = await newPortfolio("inf");
    const res = await post(`/${id}/transactions`,
      '{"symbol":"AAPL","side":"BUY","quantity":1e400,"price":1,"executed_at":"2026-01-01T00:00:00Z"}');
    expect(res.status).toBe(400);
  });

  it("rejects a non-date executed_at and a non-ticker symbol", async () => {
    const id = await newPortfolio("junk");
    expect((await post(`/${id}/transactions`, tx("BUY", 1, "lol"))).status).toBe(400);
    expect((await post(`/${id}/transactions`, tx("BUY", 1, "2026-01-01T00:00:00Z", "<script>"))).status).toBe(400);
  });

  it("rejects non-integer ids and 404s unknown portfolios", async () => {
    expect((await fetch(`${base}/abc/positions`)).status).toBe(400);
    expect((await fetch(`${base}/999999/positions`)).status).toBe(404);
    expect((await post("/999999/transactions", tx("BUY", 1, "2026-01-01T00:00:00Z"))).status).toBe(404);
  });
});

describe("position accounting", () => {
  it("closes a position fully sold in float-awkward lots (0.1 + 0.2 - 0.3)", async () => {
    const id = await newPortfolio("float");
    for (const [side, q, d] of [["BUY", 0.1, "01"], ["BUY", 0.2, "02"], ["SELL", 0.3, "03"]] as const) {
      expect((await post(`/${id}/transactions`, tx(side, q, `2026-01-${d}T00:00:00Z`))).status).toBe(201);
    }
    const [pos] = await (await fetch(`${base}/${id}/positions`)).json();
    expect(pos.quantity).toBe(0);
    expect(pos.realizedPnl).toBeCloseTo(0);
  });

  it("refuses to sell more than is held, including a sell back-dated before the buy", async () => {
    const id = await newPortfolio("oversell");
    expect((await post(`/${id}/transactions`, tx("SELL", 5, "2026-01-01T00:00:00Z"))).status).toBe(409);
    expect((await post(`/${id}/transactions`, tx("BUY", 5, "2026-02-01T00:00:00Z"))).status).toBe(201);
    expect((await post(`/${id}/transactions`, tx("SELL", 5, "2026-01-15T00:00:00Z"))).status).toBe(409);
    expect((await post(`/${id}/transactions`, tx("SELL", 5, "2026-03-01T00:00:00Z"))).status).toBe(201);
  });

  it("won't delete a buy that a later sell depends on", async () => {
    const id = await newPortfolio("dependent");
    const buy = await (await post(`/${id}/transactions`, tx("BUY", 2, "2026-01-01T00:00:00Z"))).json();
    await post(`/${id}/transactions`, tx("SELL", 2, "2026-01-02T00:00:00Z"));
    expect((await fetch(`${base}/${id}/transactions/${buy.id}`, { method: "DELETE" })).status).toBe(409);
  });
});

describe("portfolio deletion", () => {
  it("never deletes the last remaining portfolio", async () => {
    const all: Array<{ id: number }> = await (await fetch(base)).json();
    for (const p of all.slice(1)) {
      expect((await fetch(`${base}/${p.id}`, { method: "DELETE" })).status).toBe(204);
    }
    expect((await fetch(`${base}/${all[0].id}`, { method: "DELETE" })).status).toBe(409);
  });
});
