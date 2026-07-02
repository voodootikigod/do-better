import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp, formatUptime } from "../src/util.js";

test("formatUptime formats hours/minutes/seconds", () => {
  assert.equal(formatUptime(3661), "1h 1m 1s");
});

test("clamp bounds values", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});
