#!/usr/bin/env node
// Fake @adlc/hollow-test for tests. Echoes argv in canned JSON (or emits
// FAKE_STDOUT / FAKE_STDOUT_HOLLOW_TEST verbatim) and exits with
// FAKE_EXIT / FAKE_EXIT_HOLLOW_TEST (default 0).
const NAME = "hollow-test";
const ENV = NAME.toUpperCase().replace(/-/g, "_");
const argv = process.argv.slice(2);
const exitRaw = process.env[`FAKE_EXIT_${ENV}`] ?? process.env.FAKE_EXIT ?? "0";
const canned = process.env[`FAKE_STDOUT_${ENV}`] ?? process.env.FAKE_STDOUT;
const payload =
  canned ??
  JSON.stringify({ tool: NAME, argv, summary: { total: 0, killed: 0, survived: 0 }, mutants: [] });
process.stdout.write(payload + "\n");
const exitCode = Number(exitRaw);
process.exit(Number.isFinite(exitCode) ? exitCode : 0);
