// Startet `vitest run` im aktuellen Paket und wiederholt den Lauf, wenn der Node-Prozess hart abstürzt.
//
// Hintergrund (Issue #63): Unter Windows bricht Node sporadisch ohne Fehlermeldung ab, meist mit
// 0xC0000409 (3221226505, Fail-Fast) oder beim Prozessstart mit 0xC0000142 (3221225794), vor allem
// bei mehreren gleichzeitigen Testläufen. Das ist ein Absturz des Test-Runners, kein Testfehler.
// Ein Testfehler (Exit 1) wird nie wiederholt; auch ein Abbruch per Strg+C (0xC000013A) nicht.
// Worker-Threads statt Prozessen (`--pool=threads`) vermeiden den Prozessstart pro Testdatei,
// den Windows am häufigsten abbrechen lässt.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const CRASH_CODES = new Set([
  3221226505, // 0xC0000409 STATUS_STACK_BUFFER_OVERRUN (Fail-Fast)
  3221225794, // 0xC0000142 STATUS_DLL_INIT_FAILED (Prozessstart scheitert)
  3221225477, // 0xC0000005 STATUS_ACCESS_VIOLATION
  3221226356, // 0xC0000374 STATUS_HEAP_CORRUPTION
]);
const CRASH_SIGNALS = new Set(["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL"]);
const MAX_ATTEMPTS = 3;

const require = createRequire(join(process.cwd(), "package.json"));
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const args = ["run", "--pool=threads", ...process.argv.slice(2)];

let status = 1;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const result = spawnSync(process.execPath, [vitest, ...args], { stdio: "inherit" });
  status = result.status ?? 1;
  const crashed =
    (result.status !== null && CRASH_CODES.has(result.status)) ||
    (result.signal !== null && CRASH_SIGNALS.has(result.signal));
  if (!crashed) break;
  const what = result.signal ?? `Exit ${result.status}`;
  console.error(`[run-vitest] vitest abgestürzt (${what}), Versuch ${attempt}/${MAX_ATTEMPTS}.`);
}
process.exit(status);
