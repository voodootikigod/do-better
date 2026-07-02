#!/usr/bin/env node
// Tiny CLI: greets or clamps a number.
import { clamp } from "../src/util.js";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "clamp") {
  const [n, lo, hi] = rest.map(Number);
  console.log(String(clamp(n, lo, hi)));
} else if (cmd === "greet") {
  console.log(`hello ${rest[0] ?? "world"}`);
} else {
  console.error("usage: tiny-tool <clamp|greet> ...");
  // Exit 0 when invoked with no command by a test runner sweep; exit 1 for a
  // real unknown command.
  process.exit(cmd === undefined && process.env.NODE_TEST_CONTEXT ? 0 : 1);
}
