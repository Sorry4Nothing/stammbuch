import { afterAll } from "vitest";
import { KUNDE_A, KUNDE_B, closeAll, postgresStore } from "./postgres.test-support.js";
import { defineServiceTests } from "./service.suite.js";

afterAll(closeAll);

// Dieselbe fachliche Testsuite wie beim Memory-Speicher, gegen echtes PostgreSQL.
defineServiceTests(
  () => postgresStore(),
  { tenantId: KUNDE_A, userId: "u-1" },
  { tenantId: KUNDE_B, userId: "u-2" },
);
