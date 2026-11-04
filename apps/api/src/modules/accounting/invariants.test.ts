import { createMemoryStore } from "./repository.js";
import { defineInvariantTests } from "./invariants.suite.js";

defineInvariantTests(createMemoryStore, { tenantId: "t", userId: "u" });
