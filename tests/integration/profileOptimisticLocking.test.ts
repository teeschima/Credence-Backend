import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
	IdentitiesRepository,
	Identity,
} from "../../src/db/repositories/index.js";
import {
	createSchema,
	dropSchema,
	resetDatabase,
} from "../../src/db/schema.js";
import { createTestDatabase, type TestDatabase } from "./testDatabase.js";

describe("Profile optimistic locking integration", () => {
	let database: TestDatabase;
	let identitiesRepository: IdentitiesRepository;

	before(async () => {
		database = await createTestDatabase();
		await createSchema(database.pool);
		identitiesRepository = new IdentitiesRepository(database.pool);
	});

	beforeEach(async () => {
		await resetDatabase(database.pool);
	});

	after(async () => {
		await dropSchema(database.pool);
		await database.close();
	});

	describe("version field", () => {
		it("should initialize version to 1 on identity creation", async () => {
			const identity = await identitiesRepository.create({
				address: "GTEST_1",
				displayName: "Test User",
			});

			assert.equal(identity.version, 1);
		});

		it("should include version when finding identity by address", async () => {
			await identitiesRepository.create({
				address: "GTEST_2",
				displayName: "Test User",
			});

			const found = await identitiesRepository.findByAddress("GTEST_2");
			assert.ok(found);
			assert.equal(found.version, 1);
		});

		it("should include version when listing identities", async () => {
			await identitiesRepository.create({
				address: "GTEST_3",
				displayName: "User 1",
			});
			await identitiesRepository.create({
				address: "GTEST_4",
				displayName: "User 2",
			});

			const identities = await identitiesRepository.list();
			assert.equal(identities.length, 2);
			assert.ok(identities.every((i) => i.version === 1));
		});
	});

	describe("standard update", () => {
		it("should increment version on standard update", async () => {
			const identity = await identitiesRepository.create({
				address: "GTEST_UPDATE",
				displayName: "Original",
			});

			assert.equal(identity.version, 1);

			const updated = await identitiesRepository.update("GTEST_UPDATE", {
				displayName: "Updated",
			});

			assert.ok(updated);
			assert.equal(updated.version, 2);
		});

		it("should increment version multiple times on successive updates", async () => {
			await identitiesRepository.create({
				address: "GTEST_MULTI",
				displayName: "Version 1",
			});

			const update1 = await identitiesRepository.update("GTEST_MULTI", {
				displayName: "Version 2",
			});
			assert.equal(update1!.version, 2);

			const update2 = await identitiesRepository.update("GTEST_MULTI", {
				displayName: "Version 3",
			});
			assert.equal(update2!.version, 3);

			const update3 = await identitiesRepository.update("GTEST_MULTI", {
				displayName: "Version 4",
			});
			assert.equal(update3!.version, 4);
		});
	});

	describe("optimistic locking update", () => {
		it("should update identity when version matches", async () => {
			const identity = await identitiesRepository.create({
				address: "GTEST_LOCK_1",
				displayName: "Original",
			});

			assert.equal(identity.version, 1);

			const updated = await identitiesRepository.updateWithOptimisticLocking(
				"GTEST_LOCK_1",
				{
					displayName: "Updated with lock",
					expectedVersion: 1,
				}
			);

			assert.ok(updated);
			assert.equal(updated.displayName, "Updated with lock");
			assert.equal(updated.version, 2);
		});

		it("should return null when version does not match (concurrent modification)", async () => {
			await identitiesRepository.create({
				address: "GTEST_LOCK_2",
				displayName: "Original",
			});

			// First client reads version 1
			const firstRead = await identitiesRepository.findByAddress("GTEST_LOCK_2");
			assert.equal(firstRead!.version, 1);

			// Second client updates (simulating concurrent modification)
			await identitiesRepository.update("GTEST_LOCK_2", {
				displayName: "Modified by second client",
			});

			// Verify version is now 2
			const secondRead = await identitiesRepository.findByAddress("GTEST_LOCK_2");
			assert.equal(secondRead!.version, 2);

			// First client tries to update with stale version 1
			const failedUpdate = await identitiesRepository.updateWithOptimisticLocking(
				"GTEST_LOCK_2",
				{
					displayName: "Modified by first client",
					expectedVersion: 1, // stale version
				}
			);

			assert.equal(failedUpdate, null);

			// Verify the display name was not changed by the failed update
			const final = await identitiesRepository.findByAddress("GTEST_LOCK_2");
			assert.equal(final!.displayName, "Modified by second client");
			assert.equal(final!.version, 2);
		});

		it("should allow subsequent updates after retrieving current version", async () => {
			await identitiesRepository.create({
				address: "GTEST_LOCK_3",
				displayName: "Original",
			});

			// Simulate: first client reads version 1
			const firstRead = await identitiesRepository.findByAddress("GTEST_LOCK_3");

			// Second client updates
			await identitiesRepository.update("GTEST_LOCK_3", {
				displayName: "Second client update",
			});

			// First client's update with stale version fails
			const failedUpdate = await identitiesRepository.updateWithOptimisticLocking(
				"GTEST_LOCK_3",
				{
					displayName: "First client update",
					expectedVersion: firstRead!.version,
				}
			);
			assert.equal(failedUpdate, null);

			// First client refreshes and retries with current version
			const refreshed = await identitiesRepository.findByAddress("GTEST_LOCK_3");
			assert.equal(refreshed!.version, 2);

			const successUpdate = await identitiesRepository.updateWithOptimisticLocking(
				"GTEST_LOCK_3",
				{
					displayName: "First client retry",
					expectedVersion: refreshed!.version,
				}
			);

			assert.ok(successUpdate);
			assert.equal(successUpdate.displayName, "First client retry");
			assert.equal(successUpdate.version, 3);
		});

		it("should return null for non-existent identity", async () => {
			const result = await identitiesRepository.updateWithOptimisticLocking(
				"GTEST_NONEXISTENT",
				{
					displayName: "Updated",
					expectedVersion: 1,
				}
			);

			assert.equal(result, null);
		});

		it("should handle concurrent updates from multiple clients correctly", async () => {
			const identity = await identitiesRepository.create({
				address: "GTEST_CONCURRENT",
				displayName: "Original",
			});

			// Simulate 5 concurrent clients trying to update
			const clients = Array.from({ length: 5 }, (_, i) => ({
				id: i + 1,
				expectedVersion: identity.version,
				displayName: `Client ${i + 1} Update`,
			}));

			// Track successful updates
			const results: Array<{ clientId: number; success: boolean }> = [];

			// Process updates sequentially but with optimistic locking
			for (const client of clients) {
				const result = await identitiesRepository.updateWithOptimisticLocking(
					"GTEST_CONCURRENT",
					{
						displayName: client.displayName,
						expectedVersion: client.expectedVersion,
					}
				);

				results.push({
					clientId: client.id,
					success: result !== null,
				});

				// If successful, update remaining clients' expected versions
				if (result) {
					const current = await identitiesRepository.findByAddress("GTEST_CONCURRENT");
					for (const remaining of clients) {
						if (remaining.id > client.id) {
							remaining.expectedVersion = current!.version;
						}
					}
				}
			}

			// Only the first client should succeed
			assert.equal(results.filter((r) => r.success).length, 1);
			assert.ok(results[0].success);

			// Verify final state
			const final = await identitiesRepository.findByAddress("GTEST_CONCURRENT");
			assert.equal(final!.displayName, "Client 1 Update");
			assert.equal(final!.version, 2);
		});
	});

	describe("lost update prevention", () => {
		it("should prevent lost update scenario with optimistic locking", async () => {
			// Scenario: Two users read the same profile, then both try to update
			// Without optimistic locking, the second update overwrites the first (lost update)
			// With optimistic locking, the second update is rejected

			const identity = await identitiesRepository.create({
				address: "GTEST_LOST_UPDATE",
				displayName: "John Doe",
			});

			// User A reads the profile (version 1)
			const userARead = await identitiesRepository.findByAddress("GTEST_LOST_UPDATE");

			// User B reads the profile (version 1)
			const userBRead = await identitiesRepository.findByAddress("GTEST_LOST_UPDATE");

			// User A updates with optimistic locking
			const userAUpdate = await identitiesRepository.updateWithOptimisticLocking(
				"GTEST_LOST_UPDATE",
				{
					displayName: "John A. Doe",
					expectedVersion: userARead!.version,
				}
			);
			assert.ok(userAUpdate);

			// User B tries to update with stale version
			const userBUpdate = await identitiesRepository.updateWithOptimisticLocking(
				"GTEST_LOST_UPDATE",
				{
					displayName: "John B. Doe",
					expectedVersion: userBRead!.version, // stale version 1
				}
			);
			assert.equal(userBUpdate, null);

			// Verify User A's change is preserved
			const final = await identitiesRepository.findByAddress("GTEST_LOST_UPDATE");
			assert.equal(final!.displayName, "John A. Doe");
			assert.equal(final!.version, 2);
		});

		it("should handle rapid successive updates correctly", async () => {
			await identitiesRepository.create({
				address: "GTEST_RAPID",
				displayName: "Start",
			});

			// Perform 10 rapid updates
			for (let i = 1; i <= 10; i++) {
				const current = await identitiesRepository.findByAddress("GTEST_RAPID");
				const updated = await identitiesRepository.updateWithOptimisticLocking(
					"GTEST_RAPID",
					{
						displayName: `Update ${i}`,
						expectedVersion: current!.version,
					}
				);
				assert.ok(updated);
				assert.equal(updated.version, i + 1);
			}

			const final = await identitiesRepository.findByAddress("GTEST_RAPID");
			assert.equal(final!.displayName, "Update 10");
			assert.equal(final!.version, 11);
		});
	});
});
