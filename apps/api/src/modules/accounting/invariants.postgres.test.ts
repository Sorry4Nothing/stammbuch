import { afterAll } from "vitest";
import { defineInvariantTests } from "./invariants.suite.js";
import { KUNDE_A, closeAll, postgresStore } from "./postgres.test-support.js";

afterAll(closeAll);

defineInvariantTests(() => postgresStore(), { tenantId: KUNDE_A, userId: "u" });
