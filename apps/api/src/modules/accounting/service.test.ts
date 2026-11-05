import { createMemoryStore } from "./repository.js";
import { defineServiceTests } from "./service.suite.js";

defineServiceTests(
  createMemoryStore,
  { tenantId: "t-a", userId: "u-1" },
  { tenantId: "t-b", userId: "u-2" },
);
