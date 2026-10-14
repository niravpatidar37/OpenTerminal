import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { SYMBOL_RE } from "../symbol.js";

export const portfolioRouter = Router();
const MAX_QUANTITY = 1e9;
const MAX_PRICE = 1e9;

const idParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function parseId(raw: string, res: Response): number | null {
  const parsed = idParam.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: "id must be a positive integer" });
    return null;
  }
  return parsed.data;
}

function portfolioExists(id: number): boolean {
  return db.prepare("SELECT 1 FROM portfolios WHERE id = ?").get(id) !== undefined;
}

/** Portfolio-scoped routes: validate :id and 404 unknown portfolios up front. */
function withPortfolio(handler: (req: Request, res: Response, id: number) => void) {
  return (req: Request, res: Response) => {
    const id = parseId(req.params.id, res);
    if (id === null) return;
    if (!portfolioExists(id)) return res.status(404).json({ error: "portfolio not found" });
    handler(req, res, id);
  };
}

portfolioRouter.get("/", (_req, res) => {
  res.json(db.prepare("SELECT * FROM portfolios ORDER BY id").all());
});

portfolioRouter.post("/", (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(64) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "name must be 1-64 characters" });
  try {
    const info = db.prepare("INSERT INTO portfolios (name) VALUES (?)").run(parsed.data.name);
    res.status(201).json({ id: info.lastInsertRowid, name: parsed.data.name });
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "portfolio name already exists" });
    }
    throw err;
  }
});

portfolioRouter.delete(
  "/:id",
  withPortfolio((_req, res, id) => {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM portfolios").get() as { n: number }).n;
    if (count <= 1) return res.status(409).json({ error: "cannot delete the last portfolio" });
    // transactions go with it via ON DELETE CASCADE (foreign_keys = ON in db.ts)
    db.prepare("DELETE FROM portfolios WHERE id = ?").run(id);
    res.status(204).end();
  })
);

const txSchema = z.object({
  symbol: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(SYMBOL_RE, "invalid symbol")),
  side: z.enum(["BUY", "SELL"]),
  // .finite(): JSON.parse turns 1e400 into Infinity, which zod 3's
  // .positive() accepts and SQLite then stores as NULL.
  quantity: z.number().finite().positive().max(MAX_QUANTITY),
  price: z.number().finite().nonnegative().max(MAX_PRICE),
  // Stored normalized to UTC ISO-8601 so ORDER BY executed_at is chronological.
  executed_at: z
    .string()
    .datetime({ offset: true })
    .transform((s) => new Date(s).toISOString()),
});

export type TxRow = { symbol: string; side: string; quantity: number; price: number };
export type Position = { symbol: string; quantity: number; avgCost: number; realizedPnl: number };

/** Float noise allowed when comparing quantities, scaled to the quantity's size. */
const tolerance = (qty: number) => 1e-9 * Math.max(1, Math.abs(qty));

/**
 * Average-cost positions from chronologically ordered transactions.
 * `oversold` lists symbols where a SELL exceeded the quantity held at that
 * point; such sells are clamped to the held quantity in the result.
 */
export function computePositions(txs: TxRow[]): { positions: Position[]; oversold: string[] } {
  const book = new Map<string, { qty: number; avgCost: number; realizedPnl: number }>();
  const oversold = new Set<string>();
  for (const tx of txs) {
    let p = book.get(tx.symbol);
    if (!p) {
      p = { qty: 0, avgCost: 0, realizedPnl: 0 };
      book.set(tx.symbol, p);
    }
    if (tx.side === "BUY") {
      const totalCost = p.avgCost * p.qty + tx.price * tx.quantity;
      p.qty += tx.quantity;
      p.avgCost = p.qty > 0 ? totalCost / p.qty : 0;
    } else {
      const tol = tolerance(p.qty);
      if (tx.quantity > p.qty + tol) oversold.add(tx.symbol);
      const sold = Math.min(tx.quantity, p.qty);
      p.realizedPnl += (tx.price - p.avgCost) * sold;
      p.qty -= sold;
      // 0.1 + 0.2 - 0.3 leaves ~5.5e-17, not 0: snap float residue to a closed position.
      if (p.qty <= tol) {
        p.qty = 0;
        p.avgCost = 0;
      }
    }
  }
  const positions = [...book.entries()]
    .filter(([, p]) => p.qty > 0 || p.realizedPnl !== 0)
    .map(([symbol, p]) => ({ symbol, quantity: p.qty, avgCost: p.avgCost, realizedPnl: p.realizedPnl }));
  return { positions, oversold: [...oversold] };
}

const loadTxs = (id: number) =>
  db
    .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at, id")
    .all(id) as Array<TxRow & { id: number }>;

class OversoldError extends Error {}

portfolioRouter.get(
  "/:id/transactions",
  withPortfolio((_req, res, id) => {
    res.json(
      db.prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at DESC, id DESC").all(id)
    );
  })
);

portfolioRouter.post(
  "/:id/transactions",
  withPortfolio((req, res, id) => {
    const parsed = txSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    const t = parsed.data;
    // Insert and re-check holdings atomically: a SELL (or a back-dated
    // transaction) that leaves any point in the history short is rolled back.
    const insert = db.transaction(() => {
      const info = db
        .prepare(
          "INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(id, t.symbol, t.side, t.quantity, t.price, t.executed_at);
      if (computePositions(loadTxs(id).filter((x) => x.symbol === t.symbol)).oversold.length) {
        throw new OversoldError();
      }
      return info.lastInsertRowid;
    });
    try {
      res.status(201).json({ id: insert(), ...t });
    } catch (err) {
      if (err instanceof OversoldError) {
        return res.status(409).json({ error: `cannot sell more ${t.symbol} than the portfolio holds` });
      }
      throw err;
    }
  })
);

portfolioRouter.delete(
  "/:id/transactions/:txId",
  withPortfolio((req, res, id) => {
    const txId = parseId(req.params.txId, res);
    if (txId === null) return;
    const remove = db.transaction(() => {
      const row = db
        .prepare("SELECT symbol FROM transactions WHERE id = ? AND portfolio_id = ?")
        .get(txId, id) as { symbol: string } | undefined;
      if (!row) return false;
      db.prepare("DELETE FROM transactions WHERE id = ?").run(txId);
      // Deleting a BUY must not leave a later SELL selling shares never bought.
      if (computePositions(loadTxs(id).filter((x) => x.symbol === row.symbol)).oversold.length) {
        throw new OversoldError();
      }
      return true;
    });
    try {
      if (!remove()) return res.status(404).json({ error: "transaction not found" });
      res.status(204).end();
    } catch (err) {
      if (err instanceof OversoldError) {
        return res.status(409).json({ error: "deleting this buy would leave a later sell short; delete the sell first" });
      }
      throw err;
    }
  })
);

/** Aggregated positions with average cost and realized PnL (average-cost method). */
portfolioRouter.get(
  "/:id/positions",
  withPortfolio((_req, res, id) => {
    res.json(computePositions(loadTxs(id)).positions);
  })
);
