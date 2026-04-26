import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
	SettlementsRepository,
	type SettlementStatus,
} from "../../src/db/repositories/index.js";
import {
	BondsRepository,
	IdentitiesRepository,
} from "../../src/db/repositories/index.js";
import {
	createSchema,
	dropSchema,
	resetDatabase,
} from "../../src/db/schema.js";
import { createTestDatabase, type TestDatabase } from "./testDatabase.js";

const delay = async (milliseconds: number): Promise<void> => {
	await new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
};

const expectPgError = async (
	operation: Promise<unknown>,
	code: string,
): Promise<void> => {
	await assert.rejects(operation, (error: unknown) => {
		return Boolean((error as { code?: string }).code === code);
	});
};

describe("Settlements repository integration", () => {
	let database: TestDatabase;

	let identitiesRepository: IdentitiesRepository;
	let bondsRepository: BondsRepository;
	let settlementsRepository: SettlementsRepository;

	before(async () => {
		database = await createTestDatabase();

		await createSchema(database.pool);

		identitiesRepository = new IdentitiesRepository(database.pool);
		bondsRepository = new BondsRepository(database.pool);
		settlementsRepository = new SettlementsRepository(database.pool);
	});

	beforeEach(async () => {
		await resetDatabase(database.pool);
	});

	after(async () => {
		await dropSchema(database.pool);
		await database.close();
	});

	describe("upsert settlement", () => {
		it("creates a new settlement on first upsert", async () => {
			await identitiesRepository.create({ address: "GSETTLE_OWNER" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_OWNER",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			const result = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "50.5",
				transactionHash: "0xabc123",
				status: "settled",
			});

			assert.ok(result.settlement);
			assert.equal(result.settlement.bondId, String(bond.id));
			assert.equal(result.settlement.amount, "50.5");
			assert.equal(result.settlement.transactionHash, "0xabc123");
			assert.equal(result.settlement.status, "settled");
			assert.equal(result.isDuplicate, false);
		});

		it("detects duplicate when same bond_id and transaction_hash", async () => {
			await identitiesRepository.create({ address: "GSETTLE_DUP" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_DUP",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			const first = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "25",
				transactionHash: "0xduplicate",
				status: "pending",
			});

			assert.equal(first.isDuplicate, false);

			await delay(10);

			const second = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "75",
				transactionHash: "0xduplicate",
				status: "settled",
			});

			assert.equal(second.isDuplicate, true);
			assert.equal(second.settlement.amount, "75");
			assert.equal(second.settlement.status, "settled");
		});

		it("allows different transaction hashes for same bond", async () => {
			await identitiesRepository.create({ address: "GSETTLE_MULTI" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_MULTI",
				amount: "200",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 60,
			});

			const first = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "30",
				transactionHash: "0xtx1",
			});

			const second = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "45",
				transactionHash: "0xtx2",
			});

			const third = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "60",
				transactionHash: "0xtx3",
			});

			assert.equal(first.isDuplicate, false);
			assert.equal(second.isDuplicate, false);
			assert.equal(third.isDuplicate, false);
		});

		it("allows same transaction hash for different bonds", async () => {
			await identitiesRepository.create({ address: "GSETTLE_SAME_TX" });

			const bond1 = await bondsRepository.create({
				identityAddress: "GSETTLE_SAME_TX",
				amount: "50",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 15,
			});

			const bond2 = await bondsRepository.create({
				identityAddress: "GSETTLE_SAME_TX",
				amount: "75",
				startTime: new Date("2025-01-15T00:00:00.000Z"),
				durationDays: 15,
			});

			const first = await settlementsRepository.upsert({
				bondId: bond1.id,
				amount: "10",
				transactionHash: "0xsamehash",
			});

			const second = await settlementsRepository.upsert({
				bondId: bond2.id,
				amount: "20",
				transactionHash: "0xsamehash",
			});

			assert.equal(first.isDuplicate, false);
			assert.equal(second.isDuplicate, false);
		});

		it("handles all settlement statuses", async () => {
			await identitiesRepository.create({ address: "GSETTLE_STATUS" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_STATUS",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			const statuses: SettlementStatus[] = ["pending", "settled", "failed"];

			for (const status of statuses) {
				const result = await settlementsRepository.upsert({
					bondId: bond.id,
					amount: "10",
					transactionHash: `0xstatus_${status}`,
					status: status,
				});

				assert.equal(result.settlement.status, status);
			}
		});

		it("enforces unique constraint at database level", async () => {
			await identitiesRepository.create({ address: "GSETTLE_CONFLICT" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_CONFLICT",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "50",
				transactionHash: "0xconstraint",
			});

			await expectPgError(
				settlementsRepository.db.query(
					`INSERT INTO settlements (bond_id, amount, transaction_hash, status)
					 VALUES ($1, $2, $3, $4)`,
					[bond.id, "50", "0xconstraint", "settled"],
				),
				"23505",
			);
		});
	});

	describe("find settlement by id", () => {
		it("returns settlement when found", async () => {
			await identitiesRepository.create({ address: "GSETTLE_FIND_ID" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_FIND_ID",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			const created = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "50",
				transactionHash: "0xfindid",
			});

			const found = await settlementsRepository.findById(created.settlement.id);

			assert.ok(found);
			assert.equal(found.id, created.settlement.id);
			assert.equal(found.amount, "50");
		});

		it("returns null when not found", async () => {
			const found = await settlementsRepository.findById(999999);
			assert.equal(found, null);
		});
	});

	describe("find settlement by bond id", () => {
		it("returns all settlements for a bond", async () => {
			await identitiesRepository.create({ address: "GSETTLE_FIND_BOND" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_FIND_BOND",
				amount: "200",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 60,
			});

			await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "10",
				transactionHash: "0xbb1",
			});

			await delay(10);

			await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "20",
				transactionHash: "0xbb2",
			});

			const settlements = await settlementsRepository.findByBondId(bond.id);

			assert.equal(settlements.length, 2);
			assert.equal(settlements[0].amount, "20");
			assert.equal(settlements[1].amount, "10");
		});

		it("returns empty list when no settlements exist", async () => {
			const settlements = await settlementsRepository.findByBondId(999999);
			assert.deepEqual(settlements, []);
		});
	});

	describe("find settlement by transaction hash", () => {
		it("returns settlement when found by hash", async () => {
			await identitiesRepository.create({ address: "GSETTLE_FIND_TX" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_FIND_TX",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			const created = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "50",
				transactionHash: "0xfindtx123",
			});

			const found = await settlementsRepository.findByTransactionHash("0xfindtx123");

			assert.ok(found);
			assert.equal(found.id, created.settlement.id);
			assert.equal(found.transactionHash, "0xfindtx123");
		});

		it("returns null when hash not found", async () => {
			const found = await settlementsRepository.findByTransactionHash("0xnotfound");
			assert.equal(found, null);
		});
	});

	describe("count settlements by bond id", () => {
		it("returns correct count", async () => {
			await identitiesRepository.create({ address: "GSETTLE_COUNT" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_COUNT",
				amount: "200",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 60,
			});

			await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "10",
				transactionHash: "0xc1",
			});

			await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "20",
				transactionHash: "0xc2",
			});

			await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "30",
				transactionHash: "0xc3",
			});

			const count = await settlementsRepository.countByBondId(bond.id);
			assert.equal(count, 3);
		});

		it("returns zero for non-existent bond", async () => {
			const count = await settlementsRepository.countByBondId(999999);
			assert.equal(count, 0);
		});
	});

	describe("delete settlement", () => {
		it("deletes existing settlement", async () => {
			await identitiesRepository.create({ address: "GSETTLE_DELETE" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_DELETE",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			const created = await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "50",
				transactionHash: "0xdel",
			});

			const deleted = await settlementsRepository.delete(created.settlement.id);
			assert.equal(deleted, true);

			const found = await settlementsRepository.findById(created.settlement.id);
			assert.equal(found, null);
		});

		it("returns false when deleting non-existent", async () => {
			const deleted = await settlementsRepository.delete(999999);
			assert.equal(deleted, false);
		});
	});

	describe("concurrent settlement creation", () => {
		it("handles concurrent upserts from multiple transactions", async () => {
			await identitiesRepository.create({ address: "GSETTLE_CONCURRENT" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_CONCURRENT",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			const txHash = "0xconcurrent";

			const [result1, result2] = await Promise.all([
				settlementsRepository.upsert({
					bondId: bond.id,
					amount: "25",
					transactionHash: txHash,
					status: "pending",
				}),
				settlementsRepository.upsert({
					bondId: bond.id,
					amount: "50",
					transactionHash: txHash,
					status: "settled",
				}),
			]);

			const final = await settlementsRepository.findByTransactionHash(txHash);
			assert.ok(final);

			const trueCount = [result1.isDuplicate, result2.isDuplicate].filter(
				Boolean,
			).length;
			assert.equal(trueCount, 1);
		});
	});

	describe("cascade behavior", () => {
		it("cascades settlements when bond is deleted", async () => {
			await identitiesRepository.create({ address: "GSETTLE_CASCADE" });

			const bond = await bondsRepository.create({
				identityAddress: "GSETTLE_CASCADE",
				amount: "100",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			await settlementsRepository.upsert({
				bondId: bond.id,
				amount: "50",
				transactionHash: "0xcascade",
			});

			await bondsRepository.delete(bond.id);

			const settlements = await settlementsRepository.findByBondId(bond.id);
			assert.deepEqual(settlements, []);
		});
	});
});