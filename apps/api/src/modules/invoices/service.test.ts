import { defineServiceSuite } from "./service.suite.js";
import { makeService } from "./test-fixtures.js";

defineServiceSuite(() => makeService());
