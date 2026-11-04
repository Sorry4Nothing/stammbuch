import { afterAll, beforeAll } from "vitest";
import { defineServiceSuite } from "./service.suite.js";
import { PgTestServer } from "./test-pg.js";

// Dieselbe fachliche Testsuite wie service.test.ts, aber gegen echtes PostgreSQL (RLS, Trigger, Transaktionen).
let server: PgTestServer;
beforeAll(async () => {
  server = await PgTestServer.start();
}, 120_000);
afterAll(() => server?.stop());

defineServiceSuite(() => server.newContext());
