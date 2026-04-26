import { Pool } from "pg";
import {
  WalletsRepository,
  InsufficientBalanceError,
  WalletAlreadyExistsError,
} from "./walletsRepository.js";
import { LockTimeoutError } from "../transaction.js";

describe("WalletsRepository", () => {
  let pool: Pool;
  let repo: WalletsRepository;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DB_URL,
      max: 10,
    });

    // Create wallets table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        address TEXT NOT NULL UNIQUE,
        balance NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
        currency TEXT NOT NULL DEFAULT 'USD',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS wallets");
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE wallets RESTART IDENTITY CASCADE");
    repo = new WalletsRepository(pool, pool);
  });

  describe("create", () => {
    it("should create a wallet with default balance", async () => {
      const wallet = await repo.create({
        address: "0xABC123",
      });

      expect(wallet.id).toBeDefined();
      expect(wallet.address).toBe("0xABC123");
      expect(wallet.balance).toBe("0");
      expect(wallet.currency).toBe("USD");
      expect(wallet.createdAt).toBeInstanceOf(Date);
      expect(wallet.updatedAt).toBeInstanceOf(Date);
    });

    it("should create a wallet with initial balance", async () => {
      const wallet = await repo.create({
        address: "0xDEF456",
        initialBalance: "1000.50",
        currency: "ETH",
      });

      expect(wallet.balance).toBe("1000.50");
      expect(wallet.currency).toBe("ETH");
    });

    it("should throw WalletAlreadyExistsError for duplicate address", async () => {
      await repo.create({ address: "0xDUPLICATE" });

      await expect(repo.create({ address: "0xDUPLICATE" })).rejects.toThrow(
        WalletAlreadyExistsError,
      );
    });
  });

  describe("findById", () => {
    it("should find a wallet by ID", async () => {
      const created = await repo.create({ address: "0xFIND_BY_ID" });
      const found = await repo.findById(created.id);

      expect(found).toEqual(created);
    });

    it("should return null for non-existent ID", async () => {
      const found = await repo.findById("00000000-0000-0000-0000-000000000000");
      expect(found).toBeNull();
    });
  });

  describe("findByAddress", () => {
    it("should find a wallet by address", async () => {
      const created = await repo.create({ address: "0xFIND_BY_ADDR" });
      const found = await repo.findByAddress("0xFIND_BY_ADDR");

      expect(found).toEqual(created);
    });

    it("should return null for non-existent address", async () => {
      const found = await repo.findByAddress("0xNONEXISTENT");
      expect(found).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all wallets", async () => {
      await repo.create({ address: "0xWALLET1", currency: "USD" });
      await repo.create({ address: "0xWALLET2", currency: "ETH" });
      await repo.create({ address: "0xWALLET3", currency: "USD" });

      const wallets = await repo.list();
      expect(wallets).toHaveLength(3);
    });

    it("should filter wallets by currency", async () => {
      await repo.create({ address: "0xUSD1", currency: "USD" });
      await repo.create({ address: "0xETH1", currency: "ETH" });
      await repo.create({ address: "0xUSD2", currency: "USD" });

      const usdWallets = await repo.list("USD");
      expect(usdWallets).toHaveLength(2);
      expect(usdWallets.every((w) => w.currency === "USD")).toBe(true);
    });
  });

  describe("credit", () => {
    it("should add amount to wallet balance", async () => {
      const wallet = await repo.create({
        address: "0xCREDIT",
        initialBalance: "100",
      });

      const updated = await repo.credit(wallet.id, "50");

      expect(updated.balance).toBe("150");
      expect(updated.updatedAt.getTime()).toBeGreaterThan(
        wallet.updatedAt.getTime(),
      );
    });

    it("should handle concurrent credits correctly", async () => {
      const wallet = await repo.create({
        address: "0xCONCURRENT_CREDIT",
        initialBalance: "0",
      });

      // Fire 10 concurrent credits of 10 each
      await Promise.all(
        Array.from({ length: 10 }, () => repo.credit(wallet.id, "10")),
      );

      const final = await repo.findById(wallet.id);
      expect(final?.balance).toBe("100");
    });

    it("should throw error for non-existent wallet", async () => {
      await expect(
        repo.credit("00000000-0000-0000-0000-000000000000", "100"),
      ).rejects.toThrow("Wallet");
    });
  });

  describe("debit", () => {
    it("should subtract amount from wallet balance", async () => {
      const wallet = await repo.create({
        address: "0xDEBIT",
        initialBalance: "1000",
      });

      const result = await repo.debit(wallet.id, "300");

      expect(result.previousBalance).toBe("1000");
      expect(result.newBalance).toBe("700");
      expect(result.debitedAmount).toBe("300");
      expect(result.wallet.balance).toBe("700");
    });

    it("should throw InsufficientBalanceError when amount exceeds balance", async () => {
      const wallet = await repo.create({
        address: "0xINSUFFICIENT",
        initialBalance: "50",
      });

      await expect(repo.debit(wallet.id, "100")).rejects.toThrow(
        InsufficientBalanceError,
      );

      // Balance should remain unchanged
      const unchanged = await repo.findById(wallet.id);
      expect(unchanged?.balance).toBe("50");
    });

    it("should allow debit to exactly zero", async () => {
      const wallet = await repo.create({
        address: "0xZERO",
        initialBalance: "100",
      });

      const result = await repo.debit(wallet.id, "100");

      expect(result.newBalance).toBe("0");
    });

    it("should serialize concurrent debits - balance never goes negative", async () => {
      const wallet = await repo.create({
        address: "0xCONCURRENT_DEBIT",
        initialBalance: "100",
      });

      // Fire 10 concurrent debits of 10 each against a balance of 100
      // All should succeed and final balance must be exactly 0
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => repo.debit(wallet.id, "10")),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled");
      expect(succeeded).toHaveLength(10);

      const final = await repo.findById(wallet.id);
      expect(Number(final?.balance)).toBeCloseTo(0, 10);
    });

    it("should handle partial success under high concurrency", async () => {
      const wallet = await repo.create({
        address: "0xPARTIAL_SUCCESS",
        initialBalance: "50",
      });

      // 10 concurrent debits of 10 against balance of 50
      // Exactly 5 should succeed, 5 should fail with InsufficientBalanceError
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => repo.debit(wallet.id, "10")),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof InsufficientBalanceError,
      );

      expect(succeeded.length).toBe(5);
      expect(failed.length).toBe(5);

      const final = await repo.findById(wallet.id);
      expect(Number(final?.balance)).toBeCloseTo(0, 10);
    });

    it("should preserve balance when single debit exceeds available funds", async () => {
      const wallet = await repo.create({
        address: "0xEXCEED",
        initialBalance: "30",
      });

      await expect(repo.debit(wallet.id, "100")).rejects.toThrow(
        InsufficientBalanceError,
      );

      const final = await repo.findById(wallet.id);
      expect(final?.balance).toBe("30");
    });

    it("should handle multiple sequential debits correctly", async () => {
      const wallet = await repo.create({
        address: "0xSEQUENTIAL",
        initialBalance: "1000",
      });

      await repo.debit(wallet.id, "100");
      await repo.debit(wallet.id, "200");
      await repo.debit(wallet.id, "150");

      const final = await repo.findById(wallet.id);
      expect(final?.balance).toBe("550");
    });

    it("should throw error for non-existent wallet", async () => {
      await expect(
        repo.debit("00000000-0000-0000-0000-000000000000", "100"),
      ).rejects.toThrow("Wallet");
    });
  });

  describe("delete", () => {
    it("should delete a wallet", async () => {
      const wallet = await repo.create({ address: "0xDELETE" });

      const deleted = await repo.delete(wallet.id);
      expect(deleted).toBe(true);

      const found = await repo.findById(wallet.id);
      expect(found).toBeNull();
    });

    it("should return false for non-existent wallet", async () => {
      const deleted = await repo.delete("00000000-0000-0000-0000-000000000000");
      expect(deleted).toBe(false);
    });
  });

  describe("atomic debit guarantees", () => {
    it("should never produce negative balance under extreme concurrency", async () => {
      const wallet = await repo.create({
        address: "0xEXTREME",
        initialBalance: "1000",
      });

      // Fire 100 concurrent debits of 50 each
      // Only 20 should succeed (1000 / 50 = 20)
      const results = await Promise.allSettled(
        Array.from({ length: 100 }, () => repo.debit(wallet.id, "50")),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof InsufficientBalanceError,
      );

      expect(succeeded.length).toBe(20);
      expect(failed.length).toBe(80);

      const final = await repo.findById(wallet.id);
      expect(Number(final?.balance)).toBeCloseTo(0, 10);
      expect(Number(final?.balance)).toBeGreaterThanOrEqual(0);
    });

    it("should maintain consistency with mixed credit/debit operations", async () => {
      const wallet = await repo.create({
        address: "0xMIXED",
        initialBalance: "500",
      });

      // Mix of credits and debits
      await Promise.all([
        repo.debit(wallet.id, "100"),
        repo.credit(wallet.id, "200"),
        repo.debit(wallet.id, "50"),
        repo.credit(wallet.id, "150"),
        repo.debit(wallet.id, "200"),
      ]);

      const final = await repo.findById(wallet.id);
      // 500 - 100 + 200 - 50 + 150 - 200 = 500
      expect(final?.balance).toBe("500");
    });
  });
});
