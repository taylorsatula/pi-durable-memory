/**
 * probe.mjs — functional witness for ../index.ts, run against the real extension code.
 *
 * Nothing about the extension is mocked: real AES-256-GCM, real node:sqlite, real HTTP to the
 * embedding gateway. The only stand-ins are the ExtensionAPI harness that captures what the
 * extension registers (pi's runtime is not present in a bare node process) and the
 * sessionManager stub that supplies a session id.
 *
 * index.ts is copied to a scratch directory and loaded from there, because the store resolves
 * its paths from the extension's own directory. That keeps the probe out of the operator's
 * real memory.db without adding a test hook to production code.
 *
 * Usage: node bench/probe.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const PKG = path.dirname(HERE);
const SCRATCH = path.join(os.tmpdir(), "durable-memory-probe");
const CORPUS_PATH = path.join(HERE, "corpus.json");
const NEG_PATH = path.join(HERE, "neg.json");

/** pi ships typebox and pi-ai to extensions at runtime but they are not on node's resolution path from here. */
function piNodeModules() {
	const override = process.env.PI_NODE_MODULES;
	if (override) return override;
	const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
	const found = fs
		.readdirSync(releases)
		.map((v) => path.join(releases, v, "node_modules"))
		.filter((p) => fs.existsSync(path.join(p, "typebox")))
		.sort();
	if (found.length === 0) throw new Error(`no pi install with typebox under ${releases}; set PI_NODE_MODULES`);
	return found[found.length - 1];
}
const PI_NM = piNodeModules();
/** jiti ships with pi rather than with this package, so it is resolved from the same install. */
const { createJiti } = await import(path.join(PI_NM, "jiti", "lib", "jiti.mjs"));

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
};
const section = (t) => console.log(`\n${t}`);

// ── Load the extension from a scratch copy ───────────────────────────
// The default store lives in the agent directory, so every load in this probe must point
// DURABLE_MEMORY_DIR at a scratch path first: otherwise the probe would write into, and
// delete from, the operator's real store.
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const SRC = path.join(SCRATCH, "index.ts");
fs.copyFileSync(path.join(PKG, "index.ts"), SRC);
const PROBE_STORE = path.join(SCRATCH, "store");
process.env.DURABLE_MEMORY_DIR = PROBE_STORE;

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-ai": path.join(PI_NM, "@earendil-works/pi-ai/dist/index.js"),
		typebox: path.join(PI_NM, "typebox/build/index.mjs"),
	},
});
const mod = await jiti.import(SRC);

const DB = path.join(PROBE_STORE, "memory.db");
const KEY = path.join(PROBE_STORE, "memory.key");

// ── Harness ──────────────────────────────────────────────────────────
const captured = { tools: new Map(), commands: new Map(), handlers: new Map() };
const pi = {
	registerTool: (t) => captured.tools.set(t.name, t),
	registerCommand: (name, opts) => captured.commands.set(name, opts),
	on: (event, handler) => {
		if (!captured.handlers.has(event)) captured.handlers.set(event, []);
		captured.handlers.get(event).push(handler);
		return () => {};
	},
};
let SESSION = "01a00000-0000-4000-8000-000000000001";
const notices = [];
const ctx = {
	hasUI: true,
	cwd: process.cwd(),
	ui: { notify: (text, level) => notices.push({ text, level }) },
	sessionManager: { getSessionId: () => SESSION },
};
const fire = async (event) => {
	for (const h of captured.handlers.get(event) ?? []) await h({ type: event }, ctx);
};

mod.default(pi);
const tool = captured.tools.get("durable_memory");
const call = (params) => tool.execute("call-1", params, undefined, undefined, ctx);
const textOf = (r) => r.content.map((c) => c.text).join("\n");

// ── 1. registration and the system-prompt injection ──────────────────
section("[1] registration and prompt injection");
check("registers the durable_memory tool", captured.tools.has("durable_memory"));
check("registers /durable-memory", captured.commands.has("durable-memory"));
check("hooks session_start and session_shutdown", (captured.handlers.get("session_start") ?? []).length === 1 && (captured.handlers.get("session_shutdown") ?? []).length === 1);
check("contributes a promptSnippet for the tool list", typeof tool.promptSnippet === "string" && tool.promptSnippet.length > 0);
const guides = (tool.promptGuidelines ?? []).join("\n");
check("guideline makes the surface trigger transcript-checkable", /have not yet called/i.test(guides) && /Check your own transcript/i.test(guides) && /op: "surface"/.test(guides), guides);
check("guideline makes the finish trigger transcript-checkable", /have not called `durable_memory` with `op: "finish"` since completing it/i.test(guides), guides);
check("guideline asks for the surrounding-work second part", /The surrounding work:/i.test(guides), guides);
check("schema exposes all seven ops", ["surface", "finish", "create", "pointer", "edit", "delete", "helpful"].every((o) => JSON.stringify(tool.parameters).includes(o)));
check("description asks for the surrounding-work second part", /The surrounding work:/i.test(tool.description));

await fire("session_start");

// ── 2. finish is a static push alert ─────────────────────────────────
section("[2] finish is static and needs no I/O");
const f1 = await call({ op: "finish" });
const SESSION_BEFORE = SESSION;
SESSION = "01a00000-0000-4000-8000-ffffffffffff";
const f2 = await call({ op: "finish" });
SESSION = SESSION_BEFORE;
check("returns substantive instructions", textOf(f1).length > 400);
check("byte-identical across calls and sessions", textOf(f1) === textOf(f2));
check("carries the attention marker", textOf(f1).includes("⟁"));
check("instructs create", /`create`/.test(textOf(f1)));
check("instructs rating every surfaced id", /rate every id you were shown by `surface`/i.test(textOf(f1)), textOf(f1).slice(0, 300));
check("scopes the closeout to a completed task, not the session", /You just completed a task/i.test(textOf(f1)));
check("says it is repeatable within a session", /call `finish` again/i.test(textOf(f1)));
check("does not presuppose the session is ending", !/drawing to a close/i.test(textOf(f1)));
check("instructs one batched call", /ONE `durable_memory` call/i.test(textOf(f1)));
check("takes no input and touches no storage", !fs.existsSync(DB));

// ── 3. empty store ───────────────────────────────────────────────────
section("[3] surface on an empty store");
const empty = await call({ op: "surface", query: "Building a pi extension that stores encrypted memories in sqlite. The surrounding work is a single TypeScript file registering a tool." });
check("reports the store is empty", /empty/i.test(textOf(empty)), textOf(empty).slice(0, 120));
check("still carries the closeout reminder", textOf(empty).includes("⟁"));

// ── 4. retrieval accuracy over the harvested corpus ──────────────────
section("[4] retrieval over the real harvested corpus, through the tool path");
const corpus = fs.existsSync(CORPUS_PATH) ? JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")).memories : null;
if (!corpus) {
	check("corpus.json present", false, "skipping retrieval assertions; build one per bench/README.md");
} else {
	const negatives = JSON.parse(fs.readFileSync(NEG_PATH, "utf8"));
	const created = [];
	for (const m of corpus) {
		const r = await call({ op: "create", create: [m.memory] });
		created.push({ qid: m.id, storeId: r.details.report.created[0].id });
	}
	check(`stored all ${corpus.length} memories`, created.every((c) => c.storeId));

	const idOf = new Map(created.map((c) => [c.qid, c.storeId]));
	const ranks = [];
	let empties = 0;
	for (const m of corpus) {
		const rich = `${m.query}\n\nThe surrounding work: ${m.synopsis}`;
		const r = await call({ op: "surface", query: rich });
		const hits = r.details.hits ?? [];
		if (hits.length === 0) empties++;
		const rank = hits.findIndex((h) => h.id === idOf.get(m.id)) + 1;
		ranks.push({ qid: m.id, rank, n: hits.length });
	}
	const at = (k) => ranks.filter((r) => r.rank > 0 && r.rank <= k).length;
	const mrr = ranks.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / corpus.length;
	const n = corpus.length;
	console.log(`       recall@1 ${at(1)}/${n}  @3 ${at(3)}/${n}  @6 ${at(6)}/${n}  @8 ${at(8)}/${n}   MRR ${mrr.toFixed(4)}   empty results ${empties}`);
	check("recall@8 is at least 34/35", at(8) >= n - 1, ranks.filter((r) => r.rank === 0 || r.rank > 8).map((r) => `${r.qid}:${r.rank}`).join(","));
	check("MRR is at least 0.88", mrr >= 0.88, mrr.toFixed(4));
	check("no on-topic query returned nothing", empties === 0, String(empties));

	let leaked = 0;
	for (const q of negatives) {
		const r = await call({ op: "surface", query: q });
		if ((r.details.hits ?? []).length > 0) leaked++;
	}
	console.log(`       off-topic controls returning results: ${leaked}/${negatives.length}`);
	check("no off-topic control query returned a memory", leaked === 0, `${leaked} leaked`);

	const offTopic = await call({ op: "surface", query: negatives[0] });
	check("empty result reports the floor and the closest score", /cosine floor/.test(textOf(offTopic)) && /closest scored/.test(textOf(offTopic)), textOf(offTopic).slice(0, 200));
	check("empty result tells the model what to add", /The surrounding work:/.test(textOf(offTopic)));
	check("empty result still carries the closeout reminder", textOf(offTopic).includes("⟁"));

	const sample = await call({ op: "surface", query: `${corpus[0].query}\n\nThe surrounding work: ${corpus[0].synopsis}` });
	const t = textOf(sample);
	check("results render numbered with id, similarity, helpfulness", /\[1\] id: [0-9a-f]{8}\s+similarity: [\d.]+\s+helpfulness: [-\d.]+/.test(t), t.slice(0, 200));
	check("results are capped at 8", (sample.details.hits ?? []).length <= 8);
	check("ranks descend", (sample.details.hits ?? []).every((h, i, a) => i === 0 || a[i - 1].rank >= h.rank));
	check("carries the strongly worded finish reminder", /DO NOT DEFER IT TO THE END/.test(t) && /DO NOT SKIP IT/.test(t), t.slice(-400));
check("the reminder is task-scoped, not session-scoped", /WHEN THE TASK YOU SET OUT TO DO IS COMPLETE/.test(t) && /EVEN IF THE SESSION CONTINUES/.test(t));
	check("offers a re-surface naming different machinery", /different machinery/.test(t));
	check("states that the repository outranks a memory", /repository in front of you outranks it/.test(t));
	check("details expose the provenance stamp", (sample.details.hits ?? []).every((h) => typeof h.session === "string" && h.stamps >= 1));

	// ── 5. session stamping ──────────────────────────────────────────
	section("[5] session stamping is automatic and newest-wins");
	const stampTarget = created[0].storeId;
	const stampsOf = (id) => {
		const handle = new DatabaseSync(DB, { readOnly: true });
		try {
			return JSON.parse(handle.prepare("SELECT sessions FROM memories WHERE id = ?").get(id).sessions);
		} finally {
			handle.close();
		}
	};
	check("create stamped the creating session", stampsOf(stampTarget).length === 1 && stampsOf(stampTarget)[0] === SESSION, JSON.stringify(stampsOf(stampTarget)));

	SESSION = "01a00000-0000-4000-8000-000000000002";
	await call({ op: "edit", edit: [{ id: stampTarget, text: `${corpus[0].memory} (revised in a later session.)` }] });
	check("edit appended the editing session", stampsOf(stampTarget).length === 2 && stampsOf(stampTarget)[1] === SESSION, JSON.stringify(stampsOf(stampTarget)));

	await call({ op: "edit", edit: [{ id: stampTarget, text: `${corpus[0].memory} (revised twice in the same session.)` }] });
	check("a second edit in the same session does not duplicate the stamp", stampsOf(stampTarget).length === 2, JSON.stringify(stampsOf(stampTarget)));

	SESSION = "01a00000-0000-4000-8000-000000000003";
	await call({ op: "create", create: ["A memory created in a third session for the stamp test."], helpful: [{ id: stampTarget, helpful: true }] });
	check("a helpful vote does not add a stamp", stampsOf(stampTarget).length === 2, JSON.stringify(stampsOf(stampTarget)));

	const found = await call({ op: "surface", query: `${corpus[0].query}\n\nThe surrounding work: ${corpus[0].synopsis}` });
	const hit = (found.details.hits ?? []).find((h) => h.id === stampTarget);
	const stamps = stampsOf(stampTarget);
	const newest = stamps[stamps.length - 1];
	check("surface reports the newest stamp, not the oldest", hit?.session === newest && stamps.length > 1 && newest !== stamps[0], `${hit?.session} vs chain ${JSON.stringify(stamps)}`);
	check("surface reports how many sessions touched it", (hit?.stamps ?? 0) === stamps.length, `${hit?.stamps} vs ${stamps.length}`);
	check("the rendered result shows the newest session as a breadcrumb", new RegExp(`session ${newest.slice(0, 8)}`).test(textOf(found)), textOf(found).slice(0, 400));
	check("the rendered breadcrumb notes a multi-session chain", /sessions have touched it/.test(textOf(found)));

	// The stamp is server-side: no parameter the model can pass names a session.
	const propNames = [];
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.properties) for (const k of Object.keys(node.properties)) { propNames.push(k); walk(node.properties[k]); }
		if (node.items) walk(node.items);
	};
	walk(tool.parameters);
	check("no schema property lets the model supply a session", !propNames.some((p) => /session/i.test(p)), propNames.join(","));
}

// ── 6. encryption at rest ────────────────────────────────────────────
section("[6] memory bodies are ciphertext at rest");
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare("SELECT id, body, dim FROM memories").all();
db.close();
check("rows exist", rows.length > 0, String(rows.length));
check("all vectors are 1024-dim emb-qwen3", rows.every((r) => r.dim === 1024), String(rows[0]?.dim));
const needle = /mira|Taylor|banana|sqlite|embedding|memory|encrypted|pi extension/i;
const leakedRows = rows.filter((r) => needle.test(Buffer.from(r.body).toString("latin1")));
check("no plaintext survives in any stored body", leakedRows.length === 0, `${leakedRows.length} rows leaked`);
check("every body is iv(12) + tag(16) + ciphertext", rows.every((r) => Buffer.from(r.body).length > 28));

// ── 7. mutations and batching ────────────────────────────────────────
section("[7] mutations, batching, and the closeout in one call");
const before = new DatabaseSync(DB, { readOnly: true });
const n0 = Number(before.prepare("SELECT COUNT(*) AS n FROM memories").get().n);
before.close();

const batch = await call({
	op: "create",
	create: ["Batched memory one for the closeout test.", "Batched memory two for the closeout test."],
	helpful: [{ id: "deadbeef", helpful: true }],
	pointer: [{ id: "deadbeef", note: "should fail" }].slice(0, 0),
	delete: [],
});
check("batch created two memories", batch.details.report.created.length === 2);
check("batch reported the unknown rating as missing, not an error", batch.details.report.votes[0]?.missing === true);
check("missing ids are explained to the model", /matched nothing/.test(textOf(batch)), textOf(batch).slice(0, 200));
const newIds = batch.details.report.created.map((c) => c.id);
check("ids are 8 lowercase hex chars", newIds.every((id) => /^[0-9a-f]{8}$/.test(id)), newIds.join(","));

const down = await call({ op: "helpful", helpful: [{ id: newIds[0], helpful: false }, { id: newIds[1], helpful: true }] });
check("downvote and upvote both reported", down.details.report.votes.length === 2 && down.details.report.votes[0].delta < 0 && down.details.report.votes[1].delta > 0);
const scores = new DatabaseSync(DB, { readOnly: true });
const s0 = scores.prepare("SELECT score FROM memories WHERE id = ?").get(newIds[0]).score;
const s1 = scores.prepare("SELECT score FROM memories WHERE id = ?").get(newIds[1]).score;
scores.close();
check("score moved down and up respectively", s0 < 0 && s1 > 0, `${s0} / ${s1}`);

const ptr = await call({ op: "pointer", pointer: [{ id: newIds[0], note: "Caveat: only applies before the migration." }] });
check("pointer attached", ptr.details.report.pointed.length === 1);
const withNote = await call({ op: "surface", query: "I am closing out a session and need to confirm a batched memory. The surrounding work is a scratch store holding two batched test memories and one caveat note." });
const noted = (withNote.details.hits ?? []).find((h) => h.id === newIds[0]);
check("the note returns with its memory", (noted?.pointers ?? []).some((p) => p.includes("before the migration")), JSON.stringify(noted?.pointers));
check("the note is rendered inline", /↳ note:/.test(textOf(withNote)));

const del = await call({ op: "delete", delete: [newIds[0]] });
check("delete applied", del.details.report.deleted.length === 1);
const casc = new DatabaseSync(DB, { readOnly: true });
const orphan = casc.prepare("SELECT COUNT(*) AS n FROM pointers WHERE memory_id = ?").get(newIds[0]).n;
const n1 = Number(casc.prepare("SELECT COUNT(*) AS n FROM memories").get().n);
casc.close();
check("deleting a memory cascades to its pointers", Number(orphan) === 0, String(orphan));
check("row count is net +1 after create 2 / delete 1", n1 === n0 + 1, `${n0} -> ${n1}`);

const noop = await call({ op: "create" });
check("a call with no payload reports no changes", /No changes were supplied/.test(textOf(noop)));

// ── 8. failure paths propagate ───────────────────────────────────────
section("[8] failure paths propagate instead of returning empty");
const throws = async (params, pattern) => {
	try {
		await call(params);
		return false;
	} catch (e) {
		return pattern.test(e.message) ? true : `wrong message: ${e.message}`;
	}
};
check("surface without a query throws with guidance", (await throws({ op: "surface" }, /requires `query`/)) === true);
check("edit on an unknown id throws", (await throws({ op: "edit", edit: [{ id: "ffffffff", text: "x" }] }, /no memory with id/)) === true);
check("edit to empty text throws", (await throws({ op: "edit", edit: [{ id: newIds[1], text: "   " }] }, /was empty/)) === true);
check("pointer on an unknown id throws", (await throws({ op: "pointer", pointer: [{ id: "ffffffff", note: "x" }] }, /no memory with id/)) === true);
check("delete of an unknown id is a silent no-op, not a throw", (await call({ op: "delete", delete: ["ffffffff"] })).details.report.deleted.length === 0);
check("create of only whitespace stores nothing", (await call({ op: "create", create: ["   "] })).details.report.created.length === 0);
const aborted = await tool.execute("c", { op: "surface", query: "x" }, AbortSignal.abort(), undefined, ctx).then(() => false, (e) => /aborted/.test(e.message));
check("an aborted signal throws before any network call", aborted === true);

// ── 9. keyfile ───────────────────────────────────────────────────────
section("[9] keyfile");
check("key exists and is 32 bytes", fs.statSync(KEY).size === 32);
check("keyfile mode is 0600", (fs.statSync(KEY).mode & 0o777) === 0o600, (fs.statSync(KEY).mode & 0o777).toString(8));
const keyBytes = fs.readFileSync(KEY);
fs.writeFileSync(KEY, Buffer.concat([keyBytes, Buffer.from([0])]));
const { MemoryStore } = mod;
let badKey = false;
try {
	new MemoryStore(mod.storePathsOf(mod.loadConfig()));
} catch (e) {
	badKey = /expected 32/.test(e.message);
}
check("a wrong-length keyfile fails loudly rather than silently rekeying", badKey);
fs.writeFileSync(KEY, keyBytes);

// ── 10. operator command and lifecycle ───────────────────────────────
section("[10] operator command and lifecycle");
await captured.commands.get("durable-memory").handler("status", ctx);
const status = notices[notices.length - 1]?.text ?? "";
check("status reports a memory count", /memories:\s+\d+/.test(status), status);
check("status reports the endpoint and model", /endpoint:.*emb-qwen3/.test(status), status);
check("status reports the credential source", /auth\.json:lunaroute|DURABLE_MEMORY_EMBED_KEY/.test(status), status);
check("status reports the active session", status.includes(SESSION), status);
check("status reports surface and finish call counts", /surface call\(s\)/.test(status) && /finish call\(s\)/.test(status), status);

await fire("session_shutdown");
await fire("session_shutdown");
check("shutdown is idempotent", true);
let reopened = false;
try {
	await call({ op: "create", create: ["Reopened lazily after shutdown."] });
	reopened = true;
} catch {
	reopened = false;
}
check("the store reopens lazily after shutdown, as a reload requires", reopened);

section("[11] store location: a stable path, never inside the package");
check("the default store is in pi's config directory, not the package", mod.DEFAULT_STORE_DIR === path.join(os.homedir(), ".pi", "agent", "durable-memory") || Boolean(process.env.PI_CODING_AGENT_DIR), mod.DEFAULT_STORE_DIR);
check("the default is not under the extension directory", !mod.DEFAULT_STORE_DIR.startsWith(PKG), mod.DEFAULT_STORE_DIR);
check("an override redirects the store", mod.storePathsOf(mod.loadConfig()).db === DB, mod.storePathsOf(mod.loadConfig()).db);
check("the store directory was created with mode 0700", (fs.statSync(PROBE_STORE).mode & 0o777) === 0o700, (fs.statSync(PROBE_STORE).mode & 0o777).toString(8));
check("settings live at a fixed path, not inside the movable store", mod.CONFIG_PATH === path.join(mod.DEFAULT_STORE_DIR, "config.json"), mod.CONFIG_PATH);

section("[12] settings file drives endpoint, key, and directory");
check("no settings file yet", mod.loadConfig().endpoint === undefined);
const CONFIG = mod.CONFIG_PATH;
fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
const ALT_DIR = path.join(SCRATCH, "alt-store");
fs.writeFileSync(
	CONFIG,
	JSON.stringify({ endpoint: "local", url: "http://127.0.0.1:9999/v1/embeddings", model: "local-emb", apiKey: "cfg-secret", storeDir: ALT_DIR }),
	{ mode: 0o600 },
);
check("settings file is mode 0600", (fs.statSync(CONFIG).mode & 0o777) === 0o600, (fs.statSync(CONFIG).mode & 0o777).toString(8));
const loaded = mod.loadConfig();
check("endpoint is read", loaded.endpoint === "local");

// Precedence: env beats the file, which beats the defaults.
process.env.DURABLE_MEMORY_DIR = PROBE_STORE;
check("DURABLE_MEMORY_DIR beats the config file", mod.storePathsOf(loaded).dir === PROBE_STORE, mod.storePathsOf(loaded).dir);
delete process.env.DURABLE_MEMORY_DIR;
check("storeDir is read from the file", mod.storePathsOf(loaded).dir === ALT_DIR, mod.storePathsOf(loaded).dir);
check("the store reopens at the configured directory", mod.storePathsOf(loaded).db === path.join(ALT_DIR, "memory.db"));
check("config storeDir beats the default", mod.storePathsOf(loaded).dir === ALT_DIR);
process.env.DURABLE_MEMORY_DIR = PROBE_STORE;
check("DURABLE_MEMORY_DIR beats the config file", mod.storePathsOf(loaded).dir === PROBE_STORE, mod.storePathsOf(loaded).dir);
delete process.env.DURABLE_MEMORY_DIR;

// A malformed settings file must fail loudly rather than silently reverting.
fs.writeFileSync(CONFIG, "{ not json", { mode: 0o600 });
let badJson = false;
try {
	mod.loadConfig();
} catch (e) {
	badJson = /not valid JSON/.test(e.message);
}
check("a malformed settings file fails loudly", badJson);
fs.writeFileSync(CONFIG, JSON.stringify({ storeDir: path.join(SCRATCH, "node_modules", "x") }), { mode: 0o600 });
let badDir = false;
try {
	mod.storePathsOf(mod.loadConfig());
} catch (e) {
	badDir = /node_modules/.test(e.message) && /would delete the store/.test(e.message);
}
check("a stored directory inside node_modules is refused", badDir);
fs.rmSync(CONFIG, { force: true });

section("[13] settings command");
const NOTICES = [];
const settingsCtx = {
	hasUI: true,
	cwd: process.cwd(),
	ui: {
		notify: (text) => NOTICES.push(text),
		select: async (_t, options) => options[options.length - 1], // pick "Done"
		input: async () => undefined,
	},
	sessionManager: { getSessionId: () => SESSION },
};
await captured.commands.get("durable-memory").handler("status", settingsCtx);
check("status reports the settings file path", /settings:/.test(NOTICES[NOTICES.length - 1] ?? ""), NOTICES[NOTICES.length - 1]);
await captured.commands.get("durable-memory").handler("status", settingsCtx);
const st = NOTICES[NOTICES.length - 1] ?? "";
check("status reports the endpoint", /endpoint:/.test(st), st);
check("status reports the credential source", /credential:/.test(st), st);

// Choosing the endpoint writes the file, and the store picks it up with no restart.
const editCtx = {
	...settingsCtx,
	ui: {
		...settingsCtx.ui,
		select: (() => {
			let call = 0;
			return async (_t, options) => {
				call++;
				if (call === 1) return options[0]; // "Endpoint"
				if (call === 2) return options[1]; // "local"
				return options[options.length - 1]; // "Done"
			};
		})(),
		input: async () => "http://127.0.0.1:1234/v1/embeddings",
	},
};
await captured.commands.get("durable-memory").handler("", editCtx);
const after = mod.loadConfig();
check("choosing local writes endpoint=local", after.endpoint === "local", JSON.stringify(after));
check("the URL entered is stored", after.url === "http://127.0.0.1:1234/v1/embeddings", String(after.url));
check("the settings file was created 0600", (fs.statSync(CONFIG).mode & 0o777) === 0o600);
fs.rmSync(CONFIG, { force: true });

section("[14] refuses a store inside node_modules");
const SCRATCH3 = path.join(os.tmpdir(), "durable-memory-probe-third");
fs.rmSync(SCRATCH3, { recursive: true, force: true });
fs.mkdirSync(SCRATCH3, { recursive: true });
fs.copyFileSync(path.join(PKG, "index.ts"), path.join(SCRATCH3, "index.ts"));
const goodDir = process.env.DURABLE_MEMORY_DIR;
process.env.DURABLE_MEMORY_DIR = path.join(SCRATCH3, "node_modules", "some-package");
let refused = false;
try {
	await call({ op: "surface", query: "a query that should never reach the network" });
} catch (e) {
	refused = /node_modules/.test(e.message) && /would delete the store/.test(e.message);
}
check("a store path under node_modules makes the tool fail loudly", refused);
process.env.DURABLE_MEMORY_DIR = goodDir;

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
