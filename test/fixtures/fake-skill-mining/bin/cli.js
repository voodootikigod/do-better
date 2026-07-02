#!/usr/bin/env node
// Fake skill-mining CLI for hermetic tests: mines nothing, touches nothing,
// exits 0. Pointing DOBETTER_SKILL_MINING_DIR here keeps cli.test.js off the
// network (no npx resolve) and off any real sibling skill-mining checkout.
console.log(JSON.stringify({ ok: true, skills: [], note: "fake skill-mining (test fixture)" }));
