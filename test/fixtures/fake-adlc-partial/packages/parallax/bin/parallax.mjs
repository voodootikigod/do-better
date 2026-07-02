#!/usr/bin/env node
// Fake @adlc/parallax for tests. Echoes argv in canned JSON (or emits
// FAKE_STDOUT / FAKE_STDOUT_PARALLAX verbatim) and exits with
// FAKE_EXIT / FAKE_EXIT_PARALLAX (default 0).
const NAME = "parallax";
const ENV = NAME.toUpperCase().replace(/-/g, "_");
const argv = process.argv.slice(2);
const exitRaw = process.env[`FAKE_EXIT_${ENV}`] ?? process.env.FAKE_EXIT ?? "0";
const canned = process.env[`FAKE_STDOUT_${ENV}`] ?? process.env.FAKE_STDOUT;
const payload =
  canned ?? JSON.stringify({ tool: NAME, argv, score: 0.1, agreements: [], divergences: [] });
process.stdout.write(payload + "\n");
const exitCode = Number(exitRaw);
process.exit(Number.isFinite(exitCode) ? exitCode : 0);
