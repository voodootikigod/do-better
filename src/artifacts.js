// src/artifacts.js — .dobetter/ layout, frontmatter codec (documented YAML
// subset), citation parse/verify, findings + tickets I/O. Deterministic; no
// LLM, no network.

import fs from "node:fs";
import path from "node:path";
import { OpError, isSafeRelPath, log, readJsonSafe, writeFileAtomic } from "./utils.js";

// ---------------------------------------------------------------------------
// Layout (§3 of the spec, verbatim — relative to dotdir)
// ---------------------------------------------------------------------------

export const LAYOUT = {
  charter: "charter.md",
  comprehension: {
    codemap: "comprehension/codemap.md",
    architecture: "comprehension/architecture.md",
    behaviorInventory: "comprehension/behavior-inventory.md",
    dependencies: "comprehension/dependencies.md",
    railsMap: "comprehension/rails-map.md",
    glossary: "comprehension/glossary.md",
    coverageManifest: "comprehension/coverage-manifest.md",
  },
  findingsDir: "findings",
  roadmap: "ROADMAP.md",
  backlogDir: "backlog",
  backlogJson: "backlog/tickets.json",
  railsManifest: "rails/manifest.md",
  state: "state.json",
};

export function ensureLayout(dotdir) {
  const dirs = [
    dotdir,
    path.join(dotdir, "comprehension"),
    path.join(dotdir, LAYOUT.findingsDir),
    path.join(dotdir, LAYOUT.backlogDir),
    path.join(dotdir, "rails"),
    path.join(dotdir, "tmp"),
  ];
  const created = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Frontmatter codec — zero-dep YAML subset: flat `key: value` scalars
// (string/number/bool/null), `key: [a, b]` inline arrays of scalars, and ONE
// level of `key:\n  sub: val` nesting. Anything else throws (fail closed).
// ---------------------------------------------------------------------------

const KEY_RE = /^[A-Za-z0-9_-]+$/;

function parseScalarToken(tokRaw) {
  const tok = tokRaw.trim();
  if (tok === "") return "";
  if (tok.startsWith('"')) {
    try {
      return JSON.parse(tok);
    } catch {
      throw new OpError(`Invalid quoted frontmatter scalar: ${tok}`);
    }
  }
  if (tok === "true") return true;
  if (tok === "false") return false;
  if (tok === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(tok)) return Number(tok);
  return tok;
}

function splitInlineArray(inner) {
  if (inner.trim() === "") return [];
  const items = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      buf += ch;
      if (ch === "\\") {
        buf += inner[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "{") {
      throw new OpError("Nested structures are not supported in inline frontmatter arrays");
    }
    if (ch === ",") {
      items.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (inQuote) throw new OpError("Unterminated quote in inline frontmatter array");
  items.push(buf);
  return items;
}

export function parseFrontmatter(text) {
  if (typeof text !== "string") throw new OpError("parseFrontmatter expects a string");
  const lines = text.split("\n");
  if (lines[0] !== "---") return { meta: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) throw new OpError("Unterminated frontmatter block (missing closing ---)");

  const meta = {};
  let i = 1;
  while (i < end) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (!top) throw new OpError(`Unsupported frontmatter syntax: ${JSON.stringify(line)}`);
    const key = top[1];
    const rest = top[2].trim();

    if (rest === "") {
      // One level of nesting: `key:` followed by `  sub: val` lines.
      const obj = {};
      let j = i + 1;
      while (j < end) {
        const sub = lines[j];
        if (!sub.startsWith("  ") || sub.trim() === "") break;
        const m = sub.match(/^ {2}([A-Za-z0-9_-]+):\s?(.*)$/);
        if (!m) throw new OpError(`Unsupported frontmatter nesting (only one level allowed): ${JSON.stringify(sub)}`);
        const subVal = m[2].trim();
        if (subVal === "" || subVal.startsWith("[")) {
          throw new OpError(`Unsupported frontmatter nesting under "${key}.${m[1]}" (nested values must be scalars)`);
        }
        obj[m[1]] = parseScalarToken(subVal);
        j++;
      }
      meta[key] = Object.keys(obj).length === 0 ? null : obj;
      i = Math.max(j, i + 1);
      continue;
    }
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) throw new OpError(`Unterminated inline array for frontmatter key "${key}"`);
      meta[key] = splitInlineArray(rest.slice(1, -1)).map(parseScalarToken);
      i++;
      continue;
    }
    meta[key] = parseScalarToken(rest);
    i++;
  }

  const body = lines.slice(end + 1).join("\n");
  return { meta, body };
}

function needsQuote(s) {
  if (s === "") return true;
  if (/[:,#"\\\n\[\]{}]/.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  if (["true", "false", "null"].includes(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  return false;
}

function serializeScalar(v, context = "frontmatter") {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new OpError(`Non-finite number in ${context}`);
    return String(v);
  }
  if (typeof v === "string") {
    if (v.includes("\n")) return JSON.stringify(v);
    return needsQuote(v) ? JSON.stringify(v) : v;
  }
  throw new OpError(`Unsupported ${context} value type: ${typeof v}`);
}

export function serializeFrontmatter(meta, body) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (!KEY_RE.test(k)) throw new OpError(`Invalid frontmatter key: ${JSON.stringify(k)}`);
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => serializeScalar(x, `array "${k}"`)).join(", ")}]`);
    } else if (v !== null && typeof v === "object") {
      lines.push(`${k}:`);
      for (const [sk, sv] of Object.entries(v)) {
        if (!KEY_RE.test(sk)) throw new OpError(`Invalid frontmatter key: ${JSON.stringify(sk)}`);
        if (sv !== null && typeof sv === "object") {
          throw new OpError(`Frontmatter nesting deeper than one level is not supported (key "${k}.${sk}")`);
        }
        lines.push(`  ${sk}: ${serializeScalar(sv, `nested "${k}.${sk}"`)}`);
      }
    } else {
      lines.push(`${k}: ${serializeScalar(v, `key "${k}"`)}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n${body ?? ""}`;
}

// ---------------------------------------------------------------------------
// Generic artifact I/O
// ---------------------------------------------------------------------------

export function writeArtifact(dotdir, relPath, { meta = {}, body = "" } = {}) {
  if (!isSafeRelPath(relPath)) throw new OpError(`Unsafe artifact path: ${JSON.stringify(relPath)}`);
  const abs = path.join(dotdir, relPath);
  const content = Object.keys(meta).length > 0 ? serializeFrontmatter(meta, body) : body;
  writeFileAtomic(abs, content);
  return abs;
}

export function readArtifact(dotdir, relPath) {
  if (!isSafeRelPath(relPath)) throw new OpError(`Unsafe artifact path: ${JSON.stringify(relPath)}`);
  const abs = path.join(dotdir, relPath);
  if (!fs.existsSync(abs)) return null;
  return parseFrontmatter(fs.readFileSync(abs, "utf8"));
}

// ---------------------------------------------------------------------------
// Citations — canonical inline format: `path/to/file.js:123@a1b2c3d`
// ---------------------------------------------------------------------------

const CITATION_RE = /([A-Za-z0-9_][A-Za-z0-9_.\/-]*):(\d{1,7})@([0-9a-fA-F]{7,40})\b/g;

export function formatCitation({ file, line, sha }) {
  return `${file}:${line}@${sha}`;
}

export function parseCitations(text) {
  if (typeof text !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const citation = { file: m[1], line: Number(m[2]), sha: m[3].toLowerCase() };
    const key = formatCitation(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

// Deterministic, no LLM: file exists in worktree AND 1 ≤ line ≤ line-count.
export function verifyCitations(root, citations, exec) {
  const verified = [];
  const failed = [];
  const lineCountCache = new Map();
  for (const citation of citations ?? []) {
    if (!isSafeRelPath(citation.file)) {
      failed.push({ citation, reason: "unsafe path" });
      continue;
    }
    const abs = path.join(root, citation.file);
    let lineCount = lineCountCache.get(abs);
    if (lineCount === undefined) {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        lineCount = -1;
      } else {
        const content = fs.readFileSync(abs, "utf8");
        lineCount =
          content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      }
      lineCountCache.set(abs, lineCount);
    }
    if (lineCount === -1) {
      failed.push({ citation, reason: "file not found in worktree" });
      continue;
    }
    if (!Number.isInteger(citation.line) || citation.line < 1 || citation.line > lineCount) {
      failed.push({ citation, reason: `line out of range (file has ${lineCount} lines)` });
      continue;
    }
    verified.push(citation);
  }
  return { verified, failed };
}

// ---------------------------------------------------------------------------
// Machine-re-runnable reproduction checks (D6/D9). The check spec is persisted
// in finding frontmatter so refresh/roadmap re-runs can actually re-execute a
// reproduction instead of guessing from a human-readable record string.
// ok: true = still reproduces, false = no longer reproduces, null = unknowable
// (callers must NEVER treat null as resolved — a stale claim is misinformation
// with the voice of authority, but a falsely-resolved one is worse).
// ---------------------------------------------------------------------------

export function runReproCheck(root, check) {
  try {
    const type = check?.type;
    if (type === "regex" || type === "grep") {
      if (typeof check.pattern !== "string" || !isSafeRelPath(check.file ?? "")) {
        return { ok: null, record: "repro-check: malformed regex/grep spec" };
      }
      const abs = path.join(root, check.file);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return { ok: false, record: `repro-check ${type} /${check.pattern}/ in ${check.file}: file absent` };
      }
      const ok = new RegExp(check.pattern, check.flags ?? "").test(fs.readFileSync(abs, "utf8"));
      return { ok, record: `repro-check ${type} /${check.pattern}/ in ${check.file}: ${ok ? "matched" : "no match"}` };
    }
    if (type === "no-tests") {
      const ok = !["test", "tests", "__tests__"].some((d) => fs.existsSync(path.join(root, d)));
      return { ok, record: `repro-check no-tests: ${ok ? "no test dirs present" : "test dirs exist"}` };
    }
    if (type === "no-lockfile") {
      const ok = !["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some((f) => fs.existsSync(path.join(root, f)));
      return { ok, record: `repro-check no-lockfile: ${ok ? "no lockfile present" : "lockfile exists"}` };
    }
    if (type === "no-readme") {
      const ok = !fs.existsSync(path.join(root, "README.md"));
      return { ok, record: `repro-check no-readme: ${ok ? "README.md absent" : "README.md exists"}` };
    }
    return { ok: null, record: `repro-check: unknown check type ${String(type)}` };
  } catch (e) {
    return { ok: null, record: `repro-check error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const REPRO_METHODS = new Set(["command", "reread", "static"]);

export function writeFinding(dotdir, finding) {
  if (!finding || typeof finding.id !== "string" || finding.id.length === 0) {
    throw new OpError("Finding requires an id");
  }
  if (typeof finding.dimension !== "string" || finding.dimension.length === 0) {
    throw new OpError(`Finding ${finding.id}: dimension is required`);
  }
  if (typeof finding.title !== "string" || finding.title.length === 0) {
    throw new OpError(`Finding ${finding.id}: title is required`);
  }
  if (!SEVERITIES.has(finding.severity)) {
    throw new OpError(`Finding ${finding.id}: invalid severity ${JSON.stringify(finding.severity)}`);
  }
  if (!(typeof finding.confidence === "number" && finding.confidence >= 0 && finding.confidence <= 1)) {
    throw new OpError(`Finding ${finding.id}: confidence must be a number in 0..1`);
  }
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    throw new OpError(`Finding ${finding.id}: at least one evidence citation is required`);
  }
  if (finding.status !== "verified") {
    throw new OpError(`Finding ${finding.id}: unverified findings are never written (status must be "verified")`);
  }
  const repro = finding.reproduction ?? {};
  if (!REPRO_METHODS.has(repro.method)) {
    throw new OpError(`Finding ${finding.id}: invalid reproduction method ${JSON.stringify(repro.method)}`);
  }

  const meta = {
    id: finding.id,
    dimension: finding.dimension,
    title: finding.title,
    ...(typeof finding.claim === "string" && finding.claim.length > 0 ? { claim: finding.claim } : {}),
    severity: finding.severity,
    confidence: finding.confidence,
    evidence: finding.evidence.map(formatCitation),
    reproduction: {
      method: repro.method,
      record: String(repro.record ?? ""),
      exitCode: repro.exitCode ?? null,
    },
    status: "verified",
    foundAt: finding.foundAt ?? null,
    headSha: finding.headSha ?? null,
    stale: finding.stale === true,
  };
  // Machine-re-runnable reproduction (D6/D9): persist the argv array and/or the
  // deterministic check spec so refresh/roadmap re-runs can actually re-execute
  // the reproduction — the `record` string alone is human-readable, not runnable.
  if (Array.isArray(repro.cmd) && repro.cmd.length > 0) {
    if (repro.cmd.some((a) => typeof a !== "string" || a.length === 0)) {
      throw new OpError(`Finding ${finding.id}: reproduction.cmd must be an array of non-empty strings`);
    }
    meta.reproCmd = [...repro.cmd];
  }
  if (repro.check && typeof repro.check === "object") {
    if (typeof repro.check.type !== "string" || repro.check.type.length === 0) {
      throw new OpError(`Finding ${finding.id}: reproduction.check requires a string "type"`);
    }
    const checkMeta = {};
    for (const [k, v] of Object.entries(repro.check)) {
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) checkMeta[k] = v;
    }
    meta.reproCheck = checkMeta;
  }
  const body =
    typeof finding.body === "string" && finding.body.length > 0
      ? finding.body
      : [
          "",
          `# ${finding.title}`,
          "",
          `Dimension: ${finding.dimension} · Severity: ${finding.severity} · Confidence: ${finding.confidence}`,
          "",
          "## Evidence",
          ...finding.evidence.map((c) => `- ${formatCitation(c)}`),
          "",
          "## Reproduction",
          `- method: ${meta.reproduction.method}`,
          `- exit code: ${meta.reproduction.exitCode === null ? "n/a" : meta.reproduction.exitCode}`,
          "",
          "```",
          meta.reproduction.record,
          "```",
          "",
        ].join("\n");
  return writeArtifact(dotdir, `${LAYOUT.findingsDir}/${finding.id}.md`, { meta, body });
}

export function readFindings(dotdir) {
  const dir = path.join(dotdir, LAYOUT.findingsDir);
  if (!fs.existsSync(dir)) return [];
  const findings = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    try {
      const art = readArtifact(dotdir, `${LAYOUT.findingsDir}/${file}`);
      const m = art.meta;
      if (!m.id || !m.dimension || !m.title) throw new OpError("missing id/dimension/title");
      const evidence = (Array.isArray(m.evidence) ? m.evidence : [])
        .map((s) => parseCitations(String(s))[0])
        .filter(Boolean);
      const repro = m.reproduction ?? {};
      const reproduction = {
        method: String(repro.method ?? "static"),
        record: String(repro.record ?? ""),
        exitCode: repro.exitCode === null || repro.exitCode === undefined ? null : Number(repro.exitCode),
      };
      if (Array.isArray(m.reproCmd) && m.reproCmd.length > 0) {
        reproduction.cmd = m.reproCmd.map(String);
      }
      if (m.reproCheck && typeof m.reproCheck === "object") {
        reproduction.check = { ...m.reproCheck };
      }
      findings.push({
        id: String(m.id),
        dimension: String(m.dimension),
        title: String(m.title),
        ...(typeof m.claim === "string" && m.claim.length > 0 ? { claim: m.claim } : {}),
        severity: String(m.severity),
        confidence: Number(m.confidence),
        evidence,
        reproduction,
        status: String(m.status ?? ""),
        foundAt: m.foundAt ?? null,
        headSha: m.headSha ?? null,
        stale: m.stale === true,
      });
    } catch (e) {
      log.warn(`Skipping corrupt finding ${file}: ${e.message}`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Tickets — backlog/<id>.md (human view) + backlog/tickets.json (source of
// truth, byte-compatible with aidlc's .adlc/tickets.json schema).
// ---------------------------------------------------------------------------

export function writeTickets(dotdir, tickets) {
  if (!Array.isArray(tickets)) throw new OpError("writeTickets expects an array of tickets");
  writeFileAtomic(
    path.join(dotdir, LAYOUT.backlogJson),
    `${JSON.stringify({ tickets }, null, 2)}\n`,
  );
  for (const t of tickets) {
    if (!t || typeof t.id !== "string" || t.id.length === 0) {
      throw new OpError("Every ticket requires a string id");
    }
    if (!isSafeRelPath(`${t.id}.md`)) throw new OpError(`Unsafe ticket id: ${JSON.stringify(t.id)}`);
    const meta = {
      id: t.id,
      title: t.title ?? "",
      category: t.category ?? "",
      duration: typeof t.duration === "number" ? t.duration : 0,
      scope: Array.isArray(t.scope) ? t.scope : [],
      rails: Array.isArray(t.rails) ? t.rails : [],
    };
    if (typeof t.budget === "number") meta.budget = t.budget;
    const sections = ["", t.body ?? ""];
    const edges = Array.isArray(t.edges) ? t.edges : [];
    if (edges.length > 0) {
      sections.push("", "## Edges", ...edges.map((e) => `- ${e.to} — contract: ${e.contract}`));
    }
    sections.push("");
    writeArtifact(dotdir, `${LAYOUT.backlogDir}/${t.id}.md`, { meta, body: sections.join("\n") });
  }
}

export function readTickets(dotdir) {
  const json = readJsonSafe(path.join(dotdir, LAYOUT.backlogJson));
  if (json === null) return [];
  if (!Array.isArray(json.tickets)) {
    throw new OpError(`Malformed ${LAYOUT.backlogJson}: expected { "tickets": [...] }`);
  }
  return json.tickets;
}

// Mirror of aidlc validateTicket rules; [] = valid.
export function validateTicket(ticket, allIds = []) {
  const errors = [];
  const idSet = new Set(allIds);
  const isStr = (v) => typeof v === "string" && v.length > 0;
  if (!isStr(ticket?.id)) errors.push("id must be a non-empty string");
  if (!isStr(ticket?.title)) errors.push("title must be a non-empty string");
  if (!isStr(ticket?.body)) errors.push("body must be a non-empty string");
  if (!Array.isArray(ticket?.scope) || ticket.scope.some((s) => !isStr(s))) {
    errors.push("scope must be an array of non-empty strings");
  }
  if (!Array.isArray(ticket?.rails) || ticket.rails.some((s) => !isStr(s))) {
    errors.push("rails must be an array of non-empty strings");
  }
  if (!Array.isArray(ticket?.edges)) {
    errors.push("edges must be an array");
  } else {
    for (const e of ticket.edges) {
      if (!e || !isStr(e.to)) errors.push('edge missing "to"');
      else if (idSet.size > 0 && !idSet.has(e.to)) errors.push(`edge to unknown ticket "${e.to}"`);
      if (!e || !isStr(e.contract)) errors.push(`edge ${e?.to ?? "?"} missing contract`);
    }
  }
  if (!(Number.isFinite(ticket?.duration) && ticket.duration > 0)) {
    errors.push("duration must be a positive number");
  }
  if (!isStr(ticket?.category)) errors.push("category must be a non-empty string");
  if (ticket?.budget !== undefined && !(Number.isFinite(ticket.budget) && ticket.budget > 0)) {
    errors.push("budget must be a positive number when present");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Stale-claim annotation (skill-rot doctrine — flag, never trust). Idempotent.
// ---------------------------------------------------------------------------

const STALE_PREFIX = "> ⚠ STALE @";

export function annotateStale(body, { changedFiles = [], asOfSha, now } = {}) {
  const changed = new Set(changedFiles);
  const marker = `${STALE_PREFIX} ${now} (changed since ${asOfSha}):`;
  const out = [];
  let staleCount = 0;
  for (const line of String(body).split("\n")) {
    if (line.startsWith(STALE_PREFIX)) {
      out.push(line);
      continue;
    }
    const isStale = parseCitations(line).some((c) => changed.has(c.file));
    if (isStale) {
      staleCount++;
      const prev = out[out.length - 1];
      if (!(prev && prev.startsWith(STALE_PREFIX))) out.push(marker);
    }
    out.push(line);
  }
  return { body: out.join("\n"), staleCount };
}
