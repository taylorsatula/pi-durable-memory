#!/usr/bin/env node
// Apply a refinement plan to the memory store, behind a coverage gate.
//
//   node scripts/refine-apply.mjs --plan plan.json [--dir <storeDir>] [--dry] [--clear-legacy]
//
// The gate is the point. A refinement pass rewrites stored rows, and a rewrite that silently drops a
// path, a commit sha, a version, or a measured number turns a memory into a wrong instruction. So
// every identity-bearing token in a source row must appear in its replacement text, or be named in
// that operation's `allow` list with a reason the operator can read. One unaccounted token fails the
// whole plan and nothing is written.
//
// plan.json:
// {
//   "replace": [{ "id": "<8 hex>", "with": ["atomic text", ...], "allow": ["token", ...] }],
//   "edit":    [{ "id": "<8 hex>", "text": "atomic text",         "allow": ["token", ...] }],
//   "delete":  [{ "id": "<8 hex>", "why": "duplicate of <id>" }]
// }
//
// `replace` splits or merges one row into one or more rows with new ids. `edit` rewrites a row in
// place and keeps its id. `delete` needs a `why`, which is printed in the report and is the only
// record of the reason. A backup is written before anything changes.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIN_LEN = 80;
const MAX_LEN = 1400;
const EMBED_BATCH = 8;
const URLS = { remote: "https://gw.lunaroute.com/v1/embeddings", local: "http://localhost:8080/v1/embeddings" };

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = arg("--dir", join(homedir(), ".pi", "agent", "durable-memory"));
const planPath = arg("--plan", null);
const dry = process.argv.includes("--dry");
const clearLegacy = process.argv.includes("--clear-legacy");
const sessionId = process.env.PI_SESSION_ID ?? "refine-apply";

if (!planPath) {
	console.error("usage: node scripts/refine-apply.mjs --plan plan.json [--dir <storeDir>] [--dry] [--clear-legacy]");
	process.exit(2);
}
if (!existsSync(join(dir, "memory.db"))) {
	console.error(`No memory database at ${join(dir, "memory.db")}`);
	process.exit(1);
}

const plan = JSON.parse(readFileSync(planPath, "utf8"));
const cfg = existsSync(join(dir, "config.json")) ? JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) : {};
const embedUrl = process.env.DURABLE_MEMORY_EMBED_URL ?? cfg.url ?? URLS[cfg.endpoint ?? "remote"];
const embedModel = process.env.DURABLE_MEMORY_EMBED_MODEL ?? cfg.model ?? "emb-qwen3";
const embedKey = process.env.DURABLE_MEMORY_EMBED_KEY ?? cfg.apiKey ?? "";
if (!embedKey && (cfg.endpoint ?? "remote") !== "local") {
	console.error("No embedding credential. Set DURABLE_MEMORY_EMBED_KEY or apiKey in config.json.");
	process.exit(1);
}

// ── crypto ───────────────────────────────────────────────────────────

const db = new DatabaseSync(join(dir, "memory.db"));
const metaGet = (k) => db.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v;
const encrypted = metaGet("encrypted") === "true";
const keyPath = join(dir, "memory.key");
const key = encrypted ? readFileSync(keyPath) : null;
if (encrypted && key.length !== 32) {
	console.error(`${keyPath} is ${key.length} bytes, expected 32.`);
	process.exit(1);
}

function decode(body) {
	const b = Buffer.from(body);
	if (!encrypted) return b.toString("utf8");
	const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
	d.setAuthTag(b.subarray(12, 28));
	return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

function encode(text) {
	if (!encrypted) return Buffer.from(text, "utf8");
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
	return Buffer.concat([iv, c.getAuthTag(), ct]);
}

// ── token extraction ─────────────────────────────────────────────────

const TOKEN = new RegExp(
	[
		"(?<path>/[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-*<>]+)+)",
		"(?<file>\\b[A-Za-z0-9_\\-]+\\.(?:rs|go|py|js|mjs|cjs|ts|sh|yml|yaml|toml|json|md|sql|tf|txt|html|db|age)\\b)",
		"(?<hex>\\b[a-f0-9]{7,40}\\b)",
		"(?<snake>\\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\\b)",
		"(?<camel>\\b[a-z]+[A-Z][A-Za-z0-9]+\\b)",
		"(?<num>\\b\\d[\\d,.]*\\b)",
	].join("|"),
	"g",
);
const SKIP_NUM = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);

function tokens(text) {
	const out = new Set();
	for (const m of text.matchAll(TOKEN)) {
		const kind = Object.keys(m.groups).find((k) => m.groups[k] !== undefined);
		const val = m[0];
		if (kind === "num" && (SKIP_NUM.has(val) || val.startsWith("20"))) continue; // years and small counts are not identity
		out.add(val);
	}
	return out;
}

// ── gate ─────────────────────────────────────────────────────────────

const rows = new Map();
for (const r of db.prepare("SELECT id, body, score, sessions, created_at FROM memories").all()) {
	rows.set(r.id, r);
}

const problems = [];
const seen = new Map(); // id -> op kind, so one row cannot be in two operations
function claim(id, kind) {
	if (seen.has(id)) problems.push(`${id}: appears in both "${seen.get(id)}" and "${kind}"`);
	seen.set(id, kind);
	if (!rows.has(id)) problems.push(`${id}: not in the store`);
}

const replaces = plan.replace ?? [];
const edits = plan.edit ?? [];
const deletes = plan.delete ?? [];

for (const op of replaces) {
	claim(op.id, "replace");
	const pieces = op.with ?? [];
	if (!pieces.length) problems.push(`${op.id}: replace has no pieces`);
	pieces.forEach((p, i) => {
		if (p.length < MIN_LEN || p.length > MAX_LEN) {
			problems.push(`${op.id}[${i}]: ${p.length} chars, outside ${MIN_LEN}-${MAX_LEN}`);
		}
	});
	if (!rows.has(op.id)) continue;
	const allow = new Set(op.allow ?? []);
	const covered = new Set(pieces.flatMap((p) => [...tokens(p)]));
	const missing = [...tokens(decode(rows.get(op.id).body))].filter((t) => !covered.has(t) && !allow.has(t));
	if (missing.length) problems.push(`${op.id}: ${missing.length} token(s) in no piece: ${JSON.stringify(missing)}`);
}

for (const op of edits) {
	claim(op.id, "edit");
	if (!op.text || op.text.length < MIN_LEN || op.text.length > MAX_LEN) {
		problems.push(`${op.id}: edit text is ${op.text?.length ?? 0} chars, outside ${MIN_LEN}-${MAX_LEN}`);
	}
	if (!rows.has(op.id)) continue;
	const allow = new Set(op.allow ?? []);
	const covered = tokens(op.text ?? "");
	const missing = [...tokens(decode(rows.get(op.id).body))].filter((t) => !covered.has(t) && !allow.has(t));
	if (missing.length) problems.push(`${op.id}: ${missing.length} token(s) dropped: ${JSON.stringify(missing)}`);
}

for (const op of deletes) {
	claim(op.id, "delete");
	if (!op.why || !op.why.trim()) problems.push(`${op.id}: delete has no "why"`);
}

const newRowCount = replaces.reduce((n, r) => n + (r.with?.length ?? 0), 0) + edits.length;
console.log(
	`plan: ${replaces.length} replace (${replaces.length} rows -> ${replaces.reduce((n, r) => n + (r.with?.length ?? 0), 0)}), ` +
		`${edits.length} edit, ${deletes.length} delete`,
);
console.log(`store: ${rows.size} rows -> ${rows.size - replaces.length - deletes.length + replaces.reduce((n, r) => n + (r.with?.length ?? 0), 0)} rows`);

if (problems.length) {
	console.error(`\nGATE FAILED: ${problems.length} problem(s). Nothing written.`);
	for (const p of problems) console.error("  " + p);
	process.exit(1);
}
console.log("gate passed: every identity token in every source row is accounted for.");
if (dry) {
	console.log("dry run: no backup, no embedding, no write.");
	process.exit(0);
}

// ── backup ───────────────────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = join(dir, "backups");
mkdirSync(backupDir, { recursive: true });
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
const backupPath = join(backupDir, `memory-${stamp}-prerefine.db`);
copyFileSync(join(dir, "memory.db"), backupPath);
console.log(`backup: ${backupPath}`);

// ── embed ────────────────────────────────────────────────────────────

const jobs = []; // { kind, op, index, text }
replaces.forEach((op) => (op.with ?? []).forEach((text, i) => jobs.push({ kind: "replace", op, i, text })));
edits.forEach((op) => jobs.push({ kind: "edit", op, i: 0, text: op.text }));

async function embed(texts) {
	const res = await fetch(embedUrl, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${embedKey}` },
		body: JSON.stringify({ model: embedModel, input: texts }),
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${body.slice(0, 300)}`);
	const data = JSON.parse(body).data;
	if (!Array.isArray(data) || data.length !== texts.length) {
		throw new Error(`embedding returned ${data?.length ?? 0} vectors for ${texts.length} inputs`);
	}
	const byIndex = new Map(data.map((d) => [d.index, d.embedding]));
	return texts.map((_, i) => {
		const v = byIndex.get(i);
		if (!v?.length) throw new Error(`embedding for input ${i} missing or empty`);
		return v;
	});
}

const vectors = new Array(jobs.length);
for (let s = 0; s < jobs.length; s += EMBED_BATCH) {
	const batch = jobs.slice(s, s + EMBED_BATCH);
	const got = await embed(batch.map((j) => j.text));
	got.forEach((v, i) => (vectors[s + i] = v));
	process.stderr.write(`embedded ${Math.min(s + EMBED_BATCH, jobs.length)}/${jobs.length}\n`);
}

// ── write ────────────────────────────────────────────────────────────

const now = Date.now();
const toBlob = (v) => Buffer.from(new Float32Array(v).buffer);
const newId = () => {
	for (;;) {
		const id = randomBytes(4).toString("hex");
		if (!db.prepare("SELECT 1 FROM memories WHERE id = ?").get(id)) return id;
	}
};
const insert = db.prepare(
	"INSERT INTO memories (id, body, emb, score, sessions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const update = db.prepare("UPDATE memories SET body = ?, emb = ?, sessions = ?, updated_at = ? WHERE id = ?");
const remove = db.prepare("DELETE FROM memories WHERE id = ?");

db.exec("BEGIN");
try {
	let vi = 0;
	for (const op of replaces) {
		const src = rows.get(op.id);
		const stamps = JSON.parse(src.sessions);
		if (!stamps.includes(sessionId)) stamps.push(sessionId);
		for (const text of op.with ?? []) {
			insert.run(newId(), encode(text), toBlob(vectors[vi++]), src.score, JSON.stringify(stamps), src.created_at, now);
		}
		remove.run(op.id);
	}
	for (const op of edits) {
		const src = rows.get(op.id);
		const stamps = JSON.parse(src.sessions);
		if (!stamps.includes(sessionId)) stamps.push(sessionId);
		update.run(encode(op.text), toBlob(vectors[vi++]), JSON.stringify(stamps), now, op.id);
	}
	for (const op of deletes) remove.run(op.id);
	if (clearLegacy) {
		db.prepare("INSERT INTO meta (k, v) VALUES ('legacy_rows', '0') ON CONFLICT(k) DO UPDATE SET v = '0'").run();
	}
	db.exec("COMMIT");
} catch (err) {
	db.exec("ROLLBACK");
	throw err;
}

const after = db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
console.log(`wrote ${newRowCount} rows, removed ${replaces.length + deletes.length}; store now ${after} rows`);
if (clearLegacy) console.log("legacy_rows cleared: the surface byline stops offering a pass");
console.log(`integrity: ${db.prepare("PRAGMA integrity_check").get().integrity_check}`);
for (const op of deletes) console.log(`  deleted ${op.id}: ${op.why}`);
db.close();
