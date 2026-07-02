// DOBETTER_FAKE_LLM module — the sanctioned no-network test seam (§4/§8 of
// the blueprint). createLLM loads this module when the env var points at it;
// no provider/network code path is reachable.
//
// Routing: per-test scripted overrides via DOBETTER_FAKE_SCRIPT (path to a
// JSON map { label → response | [responses...] }; arrays are consumed in
// order and the last entry repeats once exhausted — this enables dry-loop
// tests). Falls back to canned defaults by exact label, then by label family
// (the part before ":"), then a generic response.

import fs from "node:fs";

let script = null;
const cursors = new Map();

function loadScript() {
  if (script !== null) return script;
  const p = process.env.DOBETTER_FAKE_SCRIPT;
  if (!p) {
    script = {};
    return script;
  }
  script = JSON.parse(fs.readFileSync(p, "utf8"));
  return script;
}

function asText(item) {
  return typeof item === "string" ? item : JSON.stringify(item);
}

function fromScript(label) {
  const s = loadScript();
  const family = label.includes(":") ? `${label.split(":")[0]}:*` : null;
  const key = Object.prototype.hasOwnProperty.call(s, label)
    ? label
    : family && Object.prototype.hasOwnProperty.call(s, family)
      ? family
      : null;
  if (key === null) return undefined;
  const list = Array.isArray(s[key]) ? s[key] : [s[key]];
  const i = cursors.get(key) ?? 0;
  cursors.set(key, i + 1);
  return asText(list[Math.min(i, list.length - 1)]);
}

const RAIL_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  'test("pinned current behavior", () => {',
  "  assert.ok(true);",
  "});",
  "",
].join("\n");

const GENERIC_TICKET = {
  title: "Generated ticket",
  body: "Generated ticket body with acceptance criteria: a command whose output is asserted.",
  scope: ["src/"],
  rails: [],
  edges: [],
  duration: 1,
  category: "maintainability",
};

// Canned defaults keyed by exact label, then by family (prefix before ":").
const CANNED = {
  codemap: "# Codemap\n\n- src/ — application source\n- test/ — tests\n- bin/ — CLI entry points\n",
  "charter-questions": JSON.stringify([
    { id: "q1", text: "What hurts most today?", recommended: "Slow, risky releases", dimension: null },
    { id: "q2", text: "12-month intent?", recommended: "stabilize", dimension: null },
    { id: "q3", text: "Weight for security (0-5)?", recommended: "3", dimension: "security" },
    { id: "q4", text: "Weight for test quality (0-5)?", recommended: "3", dimension: "test-quality" },
  ]),
  "charter-synthesis": [
    "## Pain",
    "Slow, risky releases.",
    "",
    "## Intent",
    "stabilize",
    "",
    "## Constraints",
    "- Node >= 18 only",
    "",
    "## Dimension weights",
    "- correctness: 3",
    "- security: 3",
    "- maintainability: 3",
    "- performance: 2",
    "- operability: 2",
    "- test-quality: 3",
    "- dependency-health: 2",
    "- dx: 2",
    "",
  ].join("\n"),
  reader: "## Notes\n\n- The HTTP entry point is registered at src/server.js:14@1111111.\n",
  "reader:behavior-inventory":
    "## Behaviors\n\n- B-001 (route) GET /health — health probe, entry src/server.js:14@1111111\n",
  finder: '{"candidates": []}',
  verdict: '{"verdict": "KILL"}',
  "repro-cmd": '{"reproCmd": null}',
  score: '{"items": []}',
  ticket: JSON.stringify(GENERIC_TICKET),
  "ticket-repair": JSON.stringify(GENERIC_TICKET),
  "coldstart-probe": '{"pass": true, "gaps": []}',
  rail: RAIL_TEST,
  "rail-fix": RAIL_TEST,
};

export default async function fake({ prompt = "", system = "", tier = "mid", label = "LLM", jsonMode = false } = {}) {
  const scripted = fromScript(label);
  if (scripted !== undefined) return scripted;
  const family = label.split(":")[0];
  const canned = CANNED[label] ?? CANNED[family];
  if (canned !== undefined) return canned;
  return jsonMode ? "{}" : `OK (${label}, tier=${tier})`;
}
