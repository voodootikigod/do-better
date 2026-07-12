// src/scan.js — D-1: cheap repo scan. Deterministic facts (codemap inputs,
// incantations, sizes) + a cheap-tier codemap draft. No gate; feeds D0 charter
// questions with concrete code facts (spec D8, §6 cheap tier).
import fs from "node:fs";
import path from "node:path";
import { OpError, git, gitHeadSha, readJsonSafe, truncate, warnIfDirtyTree } from "./utils.js";
import { addSpend, pinSha, recordPhase } from "./state.js";
import { LAYOUT, writeArtifact } from "./artifacts.js";
import { withFallback } from "./llm.js";

export const PHASE_ID = "scan";

const MAX_LOC_FILE_BYTES = 1024 * 1024; // LOC counted only for files ≤ 1MB
const TOP_FILES = 20;
const TOP_DIRS = 15;
const README_CHARS = 1024;
const MANIFEST_NAMES = new Set([
  "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt",
  "Gemfile", "pom.xml", "build.gradle", "composer.json", "mix.exs",
]);
const TEST_DIR_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const OFFLINE_MARKER = Symbol("scan-offline");

function requireHeadSha(root, exec) {
  try {
    return gitHeadSha(root, exec);
  } catch (err) {
    throw new OpError(
      "do-better requires a git repository with at least one commit (claims are SHA-pinned). " +
        `Could not resolve HEAD in ${root}: ${err.message}`
    );
  }
}

function countNewlines(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n += 1;
  return n;
}

function statFile(root, file) {
  let size = 0;
  let loc = 0;
  try {
    const abs = path.join(root, file);
    const st = fs.statSync(abs);
    size = st.size;
    if (st.isFile() && size > 0 && size <= MAX_LOC_FILE_BYTES) {
      loc = countNewlines(fs.readFileSync(abs));
    }
  } catch {
    // tracked but absent from the worktree — keep zeros
  }
  const extRaw = path.extname(path.basename(file));
  const ext = extRaw ? extRaw.slice(1).toLowerCase() : "(none)";
  return { file, size, loc, ext };
}

function computeExtHistogram(infos) {
  const counts = new Map();
  for (const info of infos) counts.set(info.ext, (counts.get(info.ext) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return Object.fromEntries(sorted);
}

function computeTopDirs(infos) {
  const map = new Map();
  for (const info of infos) {
    const dir = info.file.includes("/") ? info.file.split("/")[0] : "(root)";
    const cur = map.get(dir) ?? { dir, files: 0, loc: 0 };
    map.set(dir, { dir, files: cur.files + 1, loc: cur.loc + info.loc });
  }
  return [...map.values()]
    .sort((a, b) => b.loc - a.loc || b.files - a.files || a.dir.localeCompare(b.dir))
    .slice(0, TOP_DIRS);
}

function readMakefileTargets(root, files) {
  if (!files.includes("Makefile")) return [];
  let text;
  try {
    text = fs.readFileSync(path.join(root, "Makefile"), "utf8");
  } catch {
    return [];
  }
  const targets = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (m && !targets.includes(m[1])) targets.push(m[1]);
  }
  return targets;
}

function collectIncantations(root, files) {
  const scripts = {};
  const pkg = readJsonSafe(path.join(root, "package.json"));
  if (pkg && pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (typeof cmd === "string") scripts[name] = cmd;
    }
  }
  for (const target of readMakefileTargets(root, files)) {
    if (!(target in scripts)) scripts[target] = `make ${target}`;
  }
  const ci = files.filter(
    (f) =>
      f.startsWith(".github/workflows/") ||
      f === ".gitlab-ci.yml" ||
      path.basename(f) === "Jenkinsfile"
  );
  const docker = files.filter((f) => {
    const b = path.basename(f);
    return /^Dockerfile(\..+)?$/.test(b) || /^(docker-)?compose([.-][\w.-]*)?\.ya?ml$/.test(b);
  });
  return { scripts, ci, docker };
}

function collectManifests(files) {
  return files.filter((f) => MANIFEST_NAMES.has(path.basename(f)));
}

function collectDepCounts(root) {
  const pkg = readJsonSafe(path.join(root, "package.json"));
  const count = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).length : 0);
  return { prod: count(pkg?.dependencies), dev: count(pkg?.devDependencies) };
}

function countTodoMarkers(root, exec) {
  const res = exec("git", ["grep", "-c", "-I", "-E", "TODO|FIXME|HACK", "--", ".", ":(exclude).dobetter"], {
    cwd: root,
  });
  if (!res || res.status !== 0 || !res.stdout) return 0; // exit 1 = no matches
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => {
      const n = Number.parseInt(line.slice(line.lastIndexOf(":") + 1), 10);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
}

function collectTestDirs(files) {
  const dirs = new Set();
  for (const file of files) {
    const segs = file.split("/");
    for (let i = 0; i < segs.length - 1; i++) {
      if (TEST_DIR_SEGMENTS.has(segs[i].toLowerCase())) {
        dirs.add(segs.slice(0, i + 1).join("/"));
        break;
      }
    }
  }
  return [...dirs].sort();
}

function readReadmeExcerpt(root, files) {
  const candidate = files.find((f) => !f.includes("/") && /^readme(\.[\w.]+)?$/i.test(f));
  if (!candidate) return "";
  try {
    return fs.readFileSync(path.join(root, candidate), "utf8").slice(0, README_CHARS);
  } catch {
    return "";
  }
}

// Deterministic, no-LLM fact collection. Shape is the D-1 Facts contract (§7).
export function collectRepoFacts(root, exec) {
  const headSha = requireHeadSha(root, exec);
  const files = git(root, ["ls-files"], exec)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const infos = files.map((file) => statFile(root, file));
  const largestFiles = [...infos]
    .sort((a, b) => b.loc - a.loc || a.file.localeCompare(b.file))
    .slice(0, TOP_FILES)
    .map(({ file, loc }) => ({ file, loc }));
  return {
    headSha,
    fileCount: infos.length,
    locTotal: infos.reduce((sum, f) => sum + f.loc, 0),
    extHistogram: computeExtHistogram(infos),
    topDirs: computeTopDirs(infos),
    largestFiles,
    incantations: collectIncantations(root, files),
    manifests: collectManifests(files),
    depCounts: collectDepCounts(root),
    todoCount: countTodoMarkers(root, exec),
    testDirs: collectTestDirs(files),
    readmeFirstKB: readReadmeExcerpt(root, files),
  };
}

function formatList(arr, empty = "(none)") {
  return arr && arr.length ? arr.join(", ") : empty;
}

function deterministicTreeCodemap(facts) {
  const lines = [
    "# Codemap (draft)",
    "",
    `_Generated by \`do-better scan\` @ ${facts.headSha.slice(0, 7)} (structure-only). D1 comprehend verifies and extends this draft._`,
    "",
    "## Top-level directories",
  ];
  for (const d of facts.topDirs) {
    lines.push(`- \`${d.dir}\` — ${d.files} file(s), ${d.loc} LOC (structure-only)`);
  }
  lines.push("", "## Largest files");
  for (const f of facts.largestFiles.slice(0, 10)) {
    lines.push(`- \`${f.file}\` — ${f.loc} LOC (structure-only)`);
  }
  lines.push(
    "",
    "## Incantations",
    `- Scripts: ${formatList(Object.keys(facts.incantations.scripts))}`,
    `- CI: ${formatList(facts.incantations.ci)}`,
    `- Docker: ${formatList(facts.incantations.docker)}`,
    "",
    "## Manifests",
    `- ${formatList(facts.manifests)} (${facts.depCounts.prod} prod / ${facts.depCounts.dev} dev deps)`,
    ""
  );
  return lines.join("\n");
}

function buildCodemapPrompt(facts) {
  const summary = {
    fileCount: facts.fileCount,
    locTotal: facts.locTotal,
    extHistogram: facts.extHistogram,
    topDirs: facts.topDirs,
    largestFiles: facts.largestFiles,
    incantations: facts.incantations,
    manifests: facts.manifests,
    testDirs: facts.testDirs,
  };
  return [
    "Draft a codemap for an existing (brownfield) repository.",
    "Give a one-line purpose for each top-level directory and each major file.",
    "Return ONLY markdown starting with `# Codemap (draft)`, with sections:",
    "`## Top-level directories`, `## Largest files`, `## Incantations`.",
    "Do not invent files — describe only what appears in the facts below.",
    "",
    "Repository facts (deterministic scan output):",
    JSON.stringify(summary, null, 2),
    "",
    "README excerpt:",
    truncate(facts.readmeFirstKB || "(no README found)", 1000),
  ].join("\n");
}

function buildSummary(facts) {
  const topExts = Object.entries(facts.extHistogram)
    .slice(0, 3)
    .map(([ext, n]) => `${ext}×${n}`)
    .join(", ");
  return (
    `Scanned ${facts.fileCount} files (${facts.locTotal} LOC; ${topExts}) @ ${facts.headSha.slice(0, 7)}. ` +
    `Scripts: ${formatList(Object.keys(facts.incantations.scripts))}. ` +
    `CI: ${facts.incantations.ci.length} config(s). ` +
    `TODO/FIXME/HACK markers: ${facts.todoCount}. ` +
    `Test dirs: ${formatList(facts.testDirs, "none")}. ` +
    `Codemap draft → .dobetter/${LAYOUT.comprehension.codemap}`
  );
}

export async function run(ctx) {
  const { root, dotdir, exec, llm, log } = ctx;
  log.phase("D-1", "Scan");
  const headSha = requireHeadSha(root, exec);
  warnIfDirtyTree(root, exec, log, "D-1 scan"); // H10 — declared, never silent

  log.step("Collecting deterministic repo facts (no LLM)");
  const facts = collectRepoFacts(root, exec);

  let state = ctx.state;
  try {
    log.step("Drafting codemap (cheap tier)");
    const value = await withFallback(
      llm,
      { prompt: buildCodemapPrompt(facts), tier: "cheap", label: "codemap" },
      () => OFFLINE_MARKER
    );
    const body =
      value === OFFLINE_MARKER || typeof value !== "string" || !value.trim()
        ? deterministicTreeCodemap(facts)
        : value;

    // writeArtifact/recordPhase run inside the try so a post-call failure
    // (disk full, permissions) still attaches accumulated spend to err.state
    // below — otherwise the paid codemap call's cost vanishes from
    // budget.spentUSD and later runs under-count against --budget (H11).
    writeArtifact(dotdir, LAYOUT.comprehension.codemap, {
      meta: { generatedBy: "scan", headSha, draft: true },
      body,
    });

    state = addSpend(state, PHASE_ID, llm.drainSpend());
    state = recordPhase(state, PHASE_ID, { status: "done", sha: headSha, now: ctx.now(), facts });
    state = pinSha(state, PHASE_ID, headSha);
  } catch (err) {
    // Persist spend accumulated before the failure (CLI saves err.state).
    // Guard against double-drain: if state already absorbed the spend (failure
    // after addSpend), the accumulator is empty and this is a no-op.
    if (!err.state) err.state = addSpend(state, PHASE_ID, llm.drainSpend());
    throw err;
  }

  const summary = buildSummary(facts);
  log.success("Scan complete");
  return { state, gate: null, summary };
}
