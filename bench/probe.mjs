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
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
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
// Everything the extension resolves hangs off the agent directory: the default store and the
// settings file. Redirecting PI_CODING_AGENT_DIR is therefore the one lever that
// keeps this probe out of the operator's real store and real settings, whatever the default is.
fs.rmSync(SCRATCH, { recursive: true, force: true });
const AGENT = path.join(SCRATCH, "agent");
fs.mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
delete process.env.DURABLE_MEMORY_DIR;
// The extension takes its credential from env or its config file only. Source a real key into
// env — from the operator's durable-memory config, or pi's auth.json — and never symlink the
// whole config, which also names the operator's real store.
/** Assigning undefined to process.env stores the string "undefined", so only ever set a real value. */
const setEnv = (name, value) => {
	if (typeof value === "string" && value) process.env[name] = value;
};
if (!process.env.DURABLE_MEMORY_EMBED_KEY) {
	const realCfg = path.join(os.homedir(), ".pi", "agent", "durable-memory", "config.json");
	if (fs.existsSync(realCfg)) setEnv("DURABLE_MEMORY_EMBED_KEY", JSON.parse(fs.readFileSync(realCfg, "utf8")).apiKey);
	if (!process.env.DURABLE_MEMORY_EMBED_KEY) {
		try {
			const provider = process.env.DURABLE_MEMORY_EMBED_PROVIDER ?? "lunaroute";
			const entry = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"))[provider];
			setEnv("DURABLE_MEMORY_EMBED_KEY", entry?.key ?? entry?.access);
		} catch {}
	}
}
if (!process.env.DURABLE_MEMORY_EMBED_KEY) throw new Error("no embedding credential found; set DURABLE_MEMORY_EMBED_KEY");
const SRC = path.join(SCRATCH, "index.ts");
fs.copyFileSync(path.join(PKG, "index.ts"), SRC);
// package.json and release-notes.json ride along: the release-notes announcement reads both from
// beside the module, exactly as a real install lays the files out.
fs.copyFileSync(path.join(PKG, "package.json"), path.join(SCRATCH, "package.json"));
fs.copyFileSync(path.join(PKG, "release-notes.json"), path.join(SCRATCH, "release-notes.json"));
check("release notes live in a json file beside index.ts, not in index.ts itself", fs.existsSync(path.join(PKG, "release-notes.json")) && !/RELEASE_NOTES: Record<string, string> = \{\s*"/.test(fs.readFileSync(path.join(PKG, "index.ts"), "utf8")));
const PROBE_STORE = path.join(AGENT, "durable-memory");

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
const mutate = (params) => call({ action: "mutate", ...params });
const textOf = (r) => r.content.map((c) => c.text).join("\n");

// ── 1. registration and the system-prompt injection ──────────────────
section("[1] registration and prompt injection");
check("registers the durable_memory tool", captured.tools.has("durable_memory"));
check("registers /durable-memory", captured.commands.has("durable-memory"));
check("hooks session_start and session_shutdown", (captured.handlers.get("session_start") ?? []).length === 1 && (captured.handlers.get("session_shutdown") ?? []).length === 1);
check("contributes a promptSnippet for the tool list", typeof tool.promptSnippet === "string" && tool.promptSnippet.length > 0);
const guides = (tool.promptGuidelines ?? []).join("\n");
check("guideline makes the surface trigger transcript-checkable", /have not yet called/i.test(guides) && /Check your own transcript/i.test(guides) && /action: "surface"/.test(guides), guides);
check("guideline makes the checkpoint trigger transcript-checkable", /Check your transcript for a `checkpoint` call after that task or commit/i.test(guides), guides);
const actionEnum = tool.parameters.properties.action.enum;
check("the action enum is exactly surface, checkpoint, mutate, ledger",
	JSON.stringify(actionEnum) === JSON.stringify(["surface", "checkpoint", "mutate", "ledger"]),
	JSON.stringify(actionEnum));
check("the dispatch parameter is named action, not op", tool.parameters.properties.action !== undefined && tool.parameters.properties.op === undefined, JSON.stringify(Object.keys(tool.parameters.properties)));
check("the schema marks action required", (tool.parameters.required ?? []).includes("action"), JSON.stringify(tool.parameters.required));
check("the description says arguments outside the named action are rejected", /does not belong to the named action is rejected/.test(tool.description) || /named action is rejected/.test(JSON.stringify(tool.parameters)), tool.description);
check("the query parameter asks for the surrounding-work second part", /The surrounding work:/i.test(JSON.stringify(tool.parameters)));
check("the description says encryption is optional, not assumed", /optionally encrypted/i.test(tool.description), tool.description.slice(0, 140));
const schema = JSON.stringify(tool.parameters);
const BAR = "no readable text supplies";
check("the create parameter carries the storeability bar", schema.includes(BAR));
check("the edit parameter names itself the merge path for a duplicate", /rather than `create` a variant/i.test(schema));
check("names the delete-before-edit trap where it states the order", /delete first, so never delete and edit the same id/i.test(schema));
// One reading moment owns one rule: the system prompt is a single moment, so the trigger lives in the
// guidelines and the description describes the API. Across the permanent/transient boundary the
// repetition is load-bearing; inside the permanent layer it is waste.
check("the guidelines own the surface trigger", /call it before your first edit/i.test(guides), guides);
check("the description owns the api and leaves the trigger alone", !/before your first edit/i.test(tool.description) && /`action` selects what a call does/.test(tool.description), tool.description);
check("the description names all four actions and none of the dead op names", ["surface", "checkpoint", "mutate", "ledger"].every((o) => tool.description.includes(o)) && !/create, edit, delete, helpful/.test(tool.description.replace(/delete, edit, create, helpful/, "")), tool.description);

await fire("session_start");

// ── 1b. release notes: the first two interactive loads per installed version ─────
section("[1b] release notes announce on the first two loads per version, without skipping a release");
const VERSION = JSON.parse(fs.readFileSync(path.join(SCRATCH, "package.json"), "utf8")).version;
const noteNotices = (v) => notices.filter((n) => n.text.startsWith(`pi-durable-memory ${v ?? VERSION}`));
const announcedState = () => fs.readFileSync(path.join(PROBE_STORE, "announced.txt"), "utf8");
check(
	"the first session start announces the current version's short note",
	noteNotices().length === 1 && /dispatch parameter is now `action`/.test(noteNotices()[0].text),
	noteNotices().map((n) => n.text.slice(0, 80)).join(" | "),
);
check(
	"the first session start also delivers the 0.4.1 flush note to a fresh install",
	noteNotices("0.4.1").length === 1 && /delete your existing memory SQLite store/.test(noteNotices("0.4.1")[0].text),
	noteNotices("0.4.1").map((n) => n.text.slice(0, 80)).join(" | "),
);
check(
	"the flush note carries the regeneration command and the settings reassurance",
	/rm ~\/\.pi\/agent\/durable-memory\/memory\.db\*/.test(noteNotices("0.4.1")[0].text) && /config\.json is untouched/i.test(noteNotices("0.4.1")[0].text),
);
check("each version carries its own show count", announcedState() === `0.4.1 1\n0.4.2 1\n0.4.3 1\n`, JSON.stringify(announcedState()));
await fire("session_start");
check("a second session start announces each note once more", noteNotices().length === 2 && noteNotices("0.4.1").length === 2);
check("the per-version counts advance to two", announcedState() === `0.4.1 2\n0.4.2 2\n0.4.3 2\n`, JSON.stringify(announcedState()));
await fire("session_start");
check("a third session start announces nothing", noteNotices().length === 2 && noteNotices("0.4.1").length === 2);
fs.writeFileSync(path.join(PROBE_STORE, "announced.txt"), "0.0.0 2");
await (captured.handlers.get("session_start") ?? [])[0]?.({ type: "session_start" }, { ...ctx, hasUI: false });
check(
	"a headless run announces nothing and leaves the marker untouched",
	announcedState() === "0.0.0 2" && noteNotices().length === 2 && noteNotices("0.4.1").length === 2,
);
// The upgrade-without-skipping case: a user who already saw the 0.4.1 note must not see it again.
fs.writeFileSync(path.join(PROBE_STORE, "announced.txt"), "0.4.1 2");
await fire("session_start");
check(
	"a user current through 0.4.1 sees only the newer notes",
	noteNotices().length === 3 && noteNotices("0.4.1").length === 2 && announcedState() === `0.4.1 2\n0.4.2 1\n0.4.3 1\n`,
	JSON.stringify(announcedState()),
);
// The skipped-release case: a user on 0.4.0 still gets the flush note when they install 0.4.2.
fs.writeFileSync(path.join(PROBE_STORE, "announced.txt"), "0.4.0 2");
await fire("session_start");
check(
	"a user who skipped 0.4.1 still gets the flush note",
	noteNotices("0.4.1").length === 3 && /delete your existing memory SQLite store/.test(noteNotices("0.4.1")[2].text),
	noteNotices("0.4.1").map((n, i) => `${i}:${n.text.slice(0, 40)}`).join(" | "),
);

// ── 2. checkpoint is a static push alert ─────────────────────────────────
section("[2] checkpoint is static and needs no I/O");
const f1 = await call({ action: "checkpoint" });
// Line wrapping is formatting, not wording: phrase checks run on the flattened text so a re-wrap
// cannot fail a check that is about what the message says.
const flat = textOf(f1).replace(/\s+/g, " ");
const SESSION_BEFORE = SESSION;
SESSION = "01a00000-0000-4000-8000-ffffffffffff";
const f2 = await call({ action: "checkpoint" });
SESSION = SESSION_BEFORE;
check("returns substantive instructions", textOf(f1).length > 400);
check("byte-identical across calls and sessions", textOf(f1) === textOf(f2));
check("carries the attention marker", textOf(f1).includes("⟁"));
check("instructs create", /`create`/.test(textOf(f1)));
check("instructs rating every surfaced id", /rate every id `surface` showed you/i.test(textOf(f1)), textOf(f1).slice(0, 300));
check("scopes the closeout to a completed task, not the session", /You just completed a unit of work/i.test(textOf(f1)));
check("says it is repeatable within a session", /call `action: "checkpoint"` again/i.test(textOf(f1)));
check("does not presuppose the session is ending", !/drawing to a close/i.test(textOf(f1)));
check("instructs one batched mutate call", /ONE `durable_memory` call/i.test(textOf(f1)) && /`action: "mutate"`/.test(textOf(f1)));
check("says action selects what a call does and rejects strays", /`action` selects what a call does/.test(flat) && /rejected/.test(flat), flat);
check("gives a routine task a sendable answer: silence, not an empty call", /send nothing/i.test(flat) && !/empty checkpoint call/i.test(flat));
check("resends stray mutations as mutate rather than dropping them", /resend them as `action: "mutate"`/i.test(flat), flat);
check("forbids answering the prompt with another checkpoint", /never another `checkpoint`/i.test(flat));
check("forbids an empty mutate call", /never an empty `mutate`/i.test(flat), flat);
check("carries an applicable storeability bar, not just a prohibition", flat.includes(BAR));
check("one wording of the bar carries all three permanent homes and the message", [schema, tool.description, flat].every((t) => t.includes(BAR)), `${schema.includes(BAR)} ${tool.description.includes(BAR)} ${flat.includes(BAR)}`);
check("routes a near-duplicate to edit instead of a second create", /already carries the fact, `edit` it rather than `create` a second one/i.test(flat), flat);
check("closes the loop back to surface for the next task", /next task begins with `action: "surface"`/i.test(flat));
check("no interpolation survives unfilled into the message", !/\$\{/.test(flat), flat);
check("takes no input and touches no storage", !fs.existsSync(DB));

// ── 3. empty store ───────────────────────────────────────────────────
section("[3] surface on an empty store");
const empty = await call({ action: "surface", query: "Building a pi extension that stores encrypted memories in sqlite. The surrounding work is a single TypeScript file registering a tool." });
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
		const r = await mutate({ create: [m.memory] });
		created.push({ qid: m.id, storeId: r.details.report.created[0].id });
	}
	check(`stored all ${corpus.length} memories`, created.every((c) => c.storeId));

	const idOf = new Map(created.map((c) => [c.qid, c.storeId]));
	const ranks = [];
	let empties = 0;
	for (const m of corpus) {
		const rich = `${m.query}\n\nThe surrounding work: ${m.synopsis}`;
		const r = await call({ action: "surface", query: rich });
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
		const r = await call({ action: "surface", query: q });
		if ((r.details.hits ?? []).length > 0) leaked++;
	}
	console.log(`       off-topic controls returning results: ${leaked}/${negatives.length}`);
	check("no off-topic control query returned a memory", leaked === 0, `${leaked} leaked`);

	const offTopic = await call({ action: "surface", query: negatives[0] });
	check("empty result reports the floor and the closest score", /cosine floor/.test(textOf(offTopic)) && /closest scored/.test(textOf(offTopic)), textOf(offTopic).slice(0, 200));
	check("empty result tells the model what to add", /The surrounding work:/.test(textOf(offTopic)));
	check("empty result still carries the closeout reminder", textOf(offTopic).includes("⟁"));

	const sample = await call({ action: "surface", query: `${corpus[0].query}\n\nThe surrounding work: ${corpus[0].synopsis}` });
	const t = textOf(sample);
	check("results render numbered with id, similarity, helpfulness", /\[1\] id: [0-9a-f]{8}\s+similarity: [\d.]+\s+helpfulness: [-\d.]+/.test(t), t.slice(0, 200));
	check("results are capped at 8", (sample.details.hits ?? []).length <= 8);
	check("rank descends within the top-k", (sample.details.hits ?? []).every((h, i, a) => i === 0 || a[i - 1].rank >= h.rank), JSON.stringify((sample.details.hits ?? []).map((h) => [h.rank, h.similarity])));
	check("carries the strongly worded checkpoint reminder", /DO NOT DEFER IT TO THE END/.test(t) && /DO NOT SKIP IT/.test(t), t.slice(-400));
	check("the reminder is task-scoped, not session-scoped", /WHEN THE TASK YOU SET OUT TO DO IS COMPLETE/.test(t) && /DO NOT DEFER IT TO THE END/.test(t) && !/when the session ends/i.test(t), t.slice(-400));
	check("offers a re-surface naming different machinery", /different machinery/.test(t));
check("keeps the re-surface trigger for a result that already matched", /even if these matched/.test(t), t.slice(-500));
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
	await mutate({ edit: [{ id: stampTarget, text: `${corpus[0].memory} (revised in a later session.)` }] });
	check("edit appended the editing session", stampsOf(stampTarget).length === 2 && stampsOf(stampTarget)[1] === SESSION, JSON.stringify(stampsOf(stampTarget)));

	await mutate({ edit: [{ id: stampTarget, text: `${corpus[0].memory} (revised twice in the same session.)` }] });
	check("a second edit in the same session does not duplicate the stamp", stampsOf(stampTarget).length === 2, JSON.stringify(stampsOf(stampTarget)));

	SESSION = "01a00000-0000-4000-8000-000000000003";
	await mutate({ create: ["A memory created in a third session for the stamp test."], helpful: [{ id: stampTarget, helpful: true }] });
	check("a helpful vote does not add a stamp", stampsOf(stampTarget).length === 2, JSON.stringify(stampsOf(stampTarget)));

	const found = await call({ action: "surface", query: `${corpus[0].query}\n\nThe surrounding work: ${corpus[0].synopsis}` });
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

// ── 5b. debug logging of surface queries ──────────────────────────
section("[5b] debug logging: off by default, on via DURABLE_MEMORY_DEBUG or config");
const DEBUG_DB = path.join(mod.DEFAULT_STORE_DIR, "surface-log.db");
check("debug defaults to off", mod.resolveSettings().debug === false, JSON.stringify(mod.resolveSettings().debug));
check("surface calls while off wrote no debug log", !fs.existsSync(DEBUG_DB));
process.env.DURABLE_MEMORY_DEBUG = "1";
check("DURABLE_MEMORY_DEBUG=1 turns debug on", mod.resolveSettings().debug === true);
const dbgQuery = `${corpus[0].query}\n\nThe surrounding work: ${corpus[0].synopsis}`;
const dbgResult = await call({ action: "surface", query: dbgQuery });
const dbgHits = dbgResult.details.hits ?? [];
const dbgHitId = dbgHits[0]?.id;
await mutate({ helpful: [{ id: dbgHitId, helpful: true }] });
check("the debug log exists once debug is on", fs.existsSync(DEBUG_DB), DEBUG_DB);
const dbg = new DatabaseSync(DEBUG_DB, { readOnly: true });
try {
	const q = dbg.prepare("SELECT session, query, total FROM surface_queries ORDER BY id DESC LIMIT 1").get();
	check("the query row holds the session, text, and store total", q && q.session === SESSION && q.query === dbgQuery && q.total >= corpus.length, JSON.stringify(q)?.slice(0, 200));
	const hits = dbg.prepare("SELECT position, hit_id, similarity, text FROM surface_hits WHERE query_id = (SELECT MAX(id) FROM surface_queries) ORDER BY position").all();
	check("every returned hit is logged in ranked order", hits.length === dbgHits.length && hits.every((h, i) => h.hit_id === dbgHits[i].id && h.position === i + 1), JSON.stringify(hits.map((h) => [h.position, h.hit_id])));
	check("hit text is logged in plaintext, not encrypted", hits.length === 0 || corpus.some((m) => hits.some((h) => h.text.includes(m.memory.slice(0, 40)))), (hits[0]?.text ?? "").slice(0, 120));
	const vote = dbg.prepare("SELECT session, hit_id, helpful FROM surface_votes ORDER BY ts DESC LIMIT 1").get();
	check("the rating is logged against the surfaced id", vote && vote.session === SESSION && vote.hit_id === dbgHitId && vote.helpful === 1, JSON.stringify(vote));
} finally {
	dbg.close();
}
delete process.env.DURABLE_MEMORY_DEBUG;
const dbgAfter = await call({ action: "surface", query: corpus[1].query });
const dbgCount = () => {
	const h = new DatabaseSync(DEBUG_DB, { readOnly: true });
	try {
		return Number(h.prepare("SELECT COUNT(*) AS n FROM surface_queries").get().n);
	} finally {
		h.close();
	}
};
check("turning debug back off stops the logging", dbgCount() === 1, `logged ${dbgCount()} queries for 2 surface calls, only the one made while on`);

// ── 6. encryption at rest ────────────────────────────────────────────
section("[6] encryption is opt-in, and switching it on round-trips every body");
const { MemoryStore } = mod;
const readRows = () => {
	const handle = new DatabaseSync(DB, { readOnly: true });
	try {
		return handle.prepare("SELECT id, body, emb FROM memories").all();
	} finally {
		handle.close();
	}
};
const readMeta = (k) => {
	const handle = new DatabaseSync(DB, { readOnly: true });
	try {
		return handle.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v;
	} finally {
		handle.close();
	}
};
const needle = /mira|Taylor|banana|sqlite|embedding|memory|encrypted|pi extension|vault combination/i;
const readable = (rs) => rs.filter((r) => needle.test(Buffer.from(r.body).toString("latin1")));

await mutate({ create: ["The vault combination lives only in the operator's head."] });
let rows = readRows();
check("rows exist", rows.length > 0, String(rows.length));
check("all vectors are 1024-dim emb-qwen3", rows.every((r) => Buffer.from(r.emb).length === 4096), String(rows[0] && Buffer.from(rows[0].emb).length));
check("unencrypted by default", readMeta("encrypted") === "false", String(readMeta("encrypted")));
check("so by default the bodies are plaintext", readable(rows).length > 0, "no plaintext body found — the default has changed");
check("and no keyfile exists yet", !fs.existsSync(KEY));

// The operator path: the Encryption row of /durable-memory, which flips the mode on the very instance
// the tool uses. Flipping it behind the extension's back would desync the cached store from the file.
const encryptCtx = {
	...ctx,
	ui: {
		...ctx.ui,
		select: (() => {
			let n = 0;
			return async (_t, options) => (++n === 1 ? options.find((o) => o.startsWith("Encryption")) : options[options.length - 1]);
		})(),
		input: async () => undefined,
	},
};
await captured.commands.get("durable-memory").handler("", encryptCtx);
rows = readRows();
check("switching on encrypts every body", readable(rows).length === 0, `${readable(rows).length} rows still readable`);
check("every body is iv(12) + tag(16) + ciphertext", rows.every((r) => Buffer.from(r.body).length > 28));
check("the mode is recorded in meta", readMeta("encrypted") === "true", String(readMeta("encrypted")));
check("the operator is told the new mode", /now encrypted/.test(notices[notices.length - 1]?.text ?? ""), notices[notices.length - 1]?.text ?? "no notice");
check("vectors stay in the clear, since encrypted content cannot be searched", rows.every((r) => Buffer.from(r.emb).length === 4096));
const roundTrip = await call({ action: "surface", query: "Where the vault combination is kept. The surrounding work: an operator-only secret and the store that holds it." });
check("the same memory surfaces as readable text afterwards", /vault combination/i.test(textOf(roundTrip)), textOf(roundTrip).slice(0, 200));

// ── 7. mutations and batching ────────────────────────────────────────
section("[7] mutations, batching, and the closeout in one call");
const before = new DatabaseSync(DB, { readOnly: true });
const n0 = Number(before.prepare("SELECT COUNT(*) AS n FROM memories").get().n);
before.close();

const batch = await mutate({
	create: ["Batched memory one for the closeout test.", "Batched memory two for the closeout test."],
	helpful: [{ id: "deadbeef", helpful: true }],
	delete: [],
});
check("batch created two memories", batch.details.report.created.length === 2);
check("batch reported the unknown rating as missing, not an error", batch.details.report.votes[0]?.missing === true);
check("missing ids are explained to the model", /matched nothing/.test(textOf(batch)), textOf(batch).slice(0, 200));
const newIds = batch.details.report.created.map((c) => c.id);
check("ids are 8 lowercase hex chars", newIds.every((id) => /^[0-9a-f]{8}$/.test(id)), newIds.join(","));

const down = await mutate({ helpful: [{ id: newIds[0], helpful: false }, { id: newIds[1], helpful: true }] });
check("downvote and upvote both reported", down.details.report.votes.length === 2 && down.details.report.votes[0].delta < 0 && down.details.report.votes[1].delta > 0);
const scores = new DatabaseSync(DB, { readOnly: true });
const s0 = scores.prepare("SELECT score FROM memories WHERE id = ?").get(newIds[0]).score;
const s1 = scores.prepare("SELECT score FROM memories WHERE id = ?").get(newIds[1]).score;
scores.close();
check("score moved down and up respectively", s0 < 0 && s1 > 0, `${s0} / ${s1}`);

const del = await mutate({ delete: [newIds[0]] });
check("delete applied", del.details.report.deleted.length === 1);
const casc = new DatabaseSync(DB, { readOnly: true });
const n1 = Number(casc.prepare("SELECT COUNT(*) AS n FROM memories").get().n);
casc.close();
check("row count is net +1 after create 2 / delete 1", n1 === n0 + 1, `${n0} -> ${n1}`);

// A batch with one unknown id must delete nothing: every id is checked before the first write.
const keeper = await mutate({ create: ["A memory that must survive a failed batch delete."] });
const keeperId = keeper.details.report.created[0].id;
let batchErr = null;
try {
	await mutate({ delete: [keeperId, "ffffffff"] });
} catch (e) {
	batchErr = e.message;
}
const afterBatch = new DatabaseSync(DB, { readOnly: true });
const n2 = Number(afterBatch.prepare("SELECT COUNT(*) AS n FROM memories").get().n);
afterBatch.close();
check("a batch delete naming one unknown id throws", /no memory with id "ffffffff"/.test(batchErr ?? ""), batchErr ?? "no error");
check("and deleted nothing on the way out", n2 === n1 + 1, `${n1} -> ${n2}`);
await mutate({ delete: [keeperId] });

// ── 7b. per-file ledger ──────────────────────────────────────────────
section("[7b] the per-file ledger is keyed by repository and path, never embedded");
// Two scratch repositories with distinct root commits, so the same relative path names two files.
const makeRepo = (name) => {
	const dir = path.join(SCRATCH, name);
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	const run = (...args) => execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...args], { cwd: dir, stdio: "ignore" });
	run("init", "-q");
	run("commit", "-q", "--allow-empty", "-m", `root of ${name}`);
	return dir;
};
const REPO_A = makeRepo("repo-a");
const REPO_B = makeRepo("repo-b");
const inRepo = (cwd) => (params) => tool.execute("call-ledger", params, undefined, undefined, { ...ctx, cwd });
const callA = inRepo(REPO_A);
const callB = inRepo(REPO_B);
const ledgerRows = () => {
	const handle = new DatabaseSync(DB, { readOnly: true });
	try {
		return handle.prepare("SELECT repo, path, body, session FROM annotations ORDER BY id").all();
	} finally {
		handle.close();
	}
};

check("the checkpoint message asks for one note per file touched", /`annotate` — one `\{path, note\}` per file you edited or wrote/.test(flat), flat);
check("the checkpoint message states the order with annotate in it", /delete, edit, create, annotate, helpful/.test(flat));

const annotated = await callA({ action: "mutate", annotate: [{ path: "src/pager.ts", note: "Fixed the cursor off-by-one introduced in a3f9c21." }] });
check("annotate applies under mutate", annotated.details.report.annotated.length === 1 && /annotated: src\/pager\.ts/.test(textOf(annotated)), textOf(annotated));
await callA({ action: "mutate", annotate: [{ path: "./src/pager.ts", note: "Touched as part of feature wwvk." }] });
check("./ and bare relative paths key the same file", ledgerRows().length === 2 && new Set(ledgerRows().map((r) => r.path)).size === 1 && ledgerRows()[0].path === "src/pager.ts", JSON.stringify(ledgerRows().map((r) => r.path)));
check("the repository key is the root commit", /^git:[0-9a-f]{40}$/.test(ledgerRows()[0].repo), ledgerRows()[0].repo);
check("the note is stamped with the writing session", ledgerRows()[0].session === SESSION);
check("the note body follows the store's encryption mode", !/cursor off-by-one/.test(Buffer.from(ledgerRows()[0].body).toString("latin1")));

const readA = await callA({ action: "ledger", paths: ["src/pager.ts"] });
const readAText = textOf(readA);
check("ledger returns the file's notes oldest first", readAText.indexOf("off-by-one") > -1 && readAText.indexOf("off-by-one") < readAText.indexOf("feature wwvk"), readAText);
check("each line carries a date and the session prefix", new RegExp(`\\d{4}-\\d{2}-\\d{2}  ${SESSION.slice(0, 8)}  Fixed`).test(readAText), readAText);
check("details expose the ledger for renderers", readA.details.ledger?.[0]?.total === 2 && readA.details.action === "ledger");

const fromSubdir = await inRepo(path.join(REPO_A, "src"))({ action: "ledger", paths: ["pager.ts"] });
check("a path relative to a subdirectory resolves to the same file", fromSubdir.details.ledger?.[0]?.path === "src/pager.ts" && fromSubdir.details.ledger[0].total === 2, JSON.stringify(fromSubdir.details.ledger));

const readB = await callB({ action: "ledger", paths: ["src/pager.ts"] });
check("the same relative path in another repository has its own ledger", readB.details.ledger?.[0]?.total === 0 && /no notes/.test(textOf(readB)), textOf(readB));

const several = await callA({ action: "ledger", paths: ["src/pager.ts", "src/other.ts"] });
check("ledger takes several paths in one call", several.details.ledger?.length === 2 && several.details.ledger[1].total === 0);

for (let i = 0; i < 22; i++) await callA({ action: "mutate", annotate: [{ path: "src/hot.ts", note: `Pass ${i} over the hot file.` }] });
const hot = await callA({ action: "ledger", paths: ["src/hot.ts"] });
check("a busy file shows its newest 20 notes and counts the rest", hot.details.ledger[0].notes.length === 20 && /2 earlier not shown/.test(textOf(hot)) && /Pass 21 /.test(textOf(hot)) && !/Pass 1 /.test(textOf(hot)), textOf(hot).slice(0, 300));

const rejects = async (params, pattern, name) => {
	let msg = "";
	try {
		await callA(params);
	} catch (e) {
		msg = e.message;
	}
	check(name, pattern.test(msg), msg || "no error");
};
const countBefore = ledgerRows().length;
await rejects({ action: "ledger" }, /requires `paths`/, "ledger without paths is rejected");
await rejects({ action: "ledger", paths: ["src/pager.ts"], annotate: [{ path: "src/pager.ts", note: "Stray." }] }, /takes only `paths`/, "ledger carrying a note is rejected, not applied");
await rejects({ action: "ledger", paths: ["src/pager.ts"], query: "a distill" }, /takes only `paths`/, "ledger carrying a query is rejected");
await rejects({ action: "checkpoint", annotate: [{ path: "src/pager.ts", note: "Stray." }] }, /takes no argument/, "checkpoint carrying a note is rejected, not applied");
await rejects({ action: "surface", query: "a distill", annotate: [{ path: "src/pager.ts", note: "Stray." }] }, /mutation arrays are rejected/, "surface carrying a note is rejected, not applied");
await rejects({ action: "surface", query: "a distill", paths: ["src/pager.ts"] }, /does not take `paths`/, "paths outside ledger are rejected");
await rejects({ action: "mutate", annotate: [{ path: "../escape.ts", note: "Outside." }] }, /outside the repository/, "a path outside the repository is rejected");
await rejects({ action: "mutate", annotate: [{ path: "src/a.ts", note: "x".repeat(201) }] }, /at most 200 characters/, "a note longer than one short sentence is rejected");
await rejects({ action: "mutate", annotate: [{ path: "src/a.ts", note: "Fine." }, { path: "src/b.ts", note: "two\nlines" }] }, /one line/, "a multi-line note is rejected");
check("no rejected call writes a note", ledgerRows().length === countBefore, `${countBefore} -> ${ledgerRows().length}`);

// A store switched between modes rewrites ledger bodies with its memories, so neither is stranded.
{
	const dir = path.join(SCRATCH, "ledger-switch");
	const store = new MemoryStore(dir);
	store.annotate("git:probe", [{ path: "src/x.ts", note: "Plaintext ledger note." }], SESSION);
	const body = () => {
		const handle = new DatabaseSync(path.join(dir, "memory.db"), { readOnly: true });
		try {
			return Buffer.from(handle.prepare("SELECT body FROM annotations").get().body).toString("latin1");
		} finally {
			handle.close();
		}
	};
	check("an unencrypted store keeps the note in the clear", body() === "Plaintext ledger note.");
	store.switchEncryption(true);
	check("switching on encrypts ledger bodies", !/Plaintext/.test(body()));
	check("and the note still reads back", store.ledger("git:probe", "src/x.ts").notes[0]?.note === "Plaintext ledger note.");
	store.switchEncryption(false);
	check("switching off restores the plaintext", body() === "Plaintext ledger note.");
	check("the status count reads the ledger", store.annotationCount() === 1);
	store.close();
}

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
check("surface without a query throws with guidance", (await throws({ action: "surface" }, /requires `query`/)) === true);
check("edit on an unknown id throws", (await throws({ action: "mutate", edit: [{ id: "ffffffff", text: "x" }] }, /no memory with id/)) === true);
check("edit to empty text throws", (await throws({ action: "mutate", edit: [{ id: newIds[1], text: "   " }] }, /was empty/)) === true);
check("delete of an unknown id throws, not a silent no-op", (await throws({ action: "mutate", delete: ["ffffffff"] }, /no memory with id/)) === true);
check("a mutate call with no payload throws", (await throws({ action: "mutate" }, /applied nothing/)) === true);
// Strict dispatch: a strayed argument is rejected, never ignored, never applied. The count is read
// before and after, because the failure this guards against is a silent write.
check("surface carrying mutation arrays is rejected", (await throws({ action: "surface", query: "x", helpful: [{ id: newIds[1], helpful: true }] }, /takes only `query`/)) === true);
check("checkpoint carrying mutations is rejected", (await throws({ action: "checkpoint", create: ["strayed"] }, /takes no argument/)) === true);
check("checkpoint carrying a query is rejected", (await throws({ action: "checkpoint", query: "strayed" }, /takes no argument/)) === true);
check("a call with no action names nothing and throws", (await throws({}, /requires `action`/)) === true);
const countRows = () => {
	const h = new DatabaseSync(DB, { readOnly: true });
	try {
		return Number(h.prepare("SELECT COUNT(*) AS n FROM memories").get().n);
	} finally {
		h.close();
	}
};

check("the rejected checkpoint call stored nothing", countRows() === n1, `${countRows()} vs ${n1}`);
check("create of only whitespace throws and stores nothing", (await throws({ action: "mutate", create: ["   "] }, /applied nothing/)) === true && countRows() === n1, `${countRows()} vs ${n1}`);
const aborted = await tool.execute("c", { action: "surface", query: "x" }, AbortSignal.abort(), undefined, ctx).then(() => false, (e) => /aborted/.test(e.message));
check("an aborted signal throws before any network call", aborted === true);

// ── 9. keyfile ───────────────────────────────────────────────────────
section("[9] keyfile");
check("key exists and is 32 bytes", fs.statSync(KEY).size === 32);
check("keyfile mode is 0600", (fs.statSync(KEY).mode & 0o777) === 0o600, (fs.statSync(KEY).mode & 0o777).toString(8));
const keyBytes = fs.readFileSync(KEY);
fs.writeFileSync(KEY, Buffer.concat([keyBytes, Buffer.from([0])]));
let badKey = false;
try {
	new MemoryStore(mod.resolveSettings().storeDir);
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
check("status reports the auth-key source", /auth key:\s+\S/.test(status), status);
check("status reports the active session", status.includes(SESSION), status);
check("status reports the surface-call count", /\d+ surface call/.test(status), status);
check("status reports the ledger count", /ledger:\s+\d+ file note/.test(status), status);

await fire("session_shutdown");
await fire("session_shutdown");
check("shutdown is idempotent", true);
let reopened = false;
try {
	await mutate({ create: ["Reopened lazily after shutdown."] });
	reopened = true;
} catch {
	reopened = false;
}
check("the store reopens lazily after shutdown, as a reload requires", reopened);

section("[11] store location: a stable path, never inside the package");
check("the default follows PI_CODING_AGENT_DIR", mod.DEFAULT_STORE_DIR === path.join(AGENT, "durable-memory"), mod.DEFAULT_STORE_DIR);
check("the default is not under the extension directory", !mod.DEFAULT_STORE_DIR.startsWith(PKG), mod.DEFAULT_STORE_DIR);
check("the store is the agent-dir default", mod.resolveSettings().storeDir === PROBE_STORE, mod.resolveSettings().storeDir);
check("the store directory was created with mode 0700", (fs.statSync(PROBE_STORE).mode & 0o777) === 0o700, (fs.statSync(PROBE_STORE).mode & 0o777).toString(8));
check("settings live at a fixed path, not inside the movable store", mod.CONFIG_PATH === path.join(mod.DEFAULT_STORE_DIR, "config.json"), mod.CONFIG_PATH);

section("[12] settings file drives endpoint, key, and directory");
const CONFIG = mod.CONFIG_PATH;
fs.rmSync(CONFIG, { force: true });
const pre = mod.readSettings();
check(
	"a missing config prefills the defaults on read",
	pre.endpoint === "remote" && pre.model === "emb-qwen3" && pre.storeDir === mod.DEFAULT_STORE_DIR && pre.debug === false,
	JSON.stringify(pre),
);
check("the prefill names no url, so the endpoint's preset applies", pre.url === undefined, JSON.stringify(pre));
check("the prefill is written to the file", JSON.parse(fs.readFileSync(CONFIG, "utf8")).model === "emb-qwen3");
check("the resolved url is the remote preset", mod.resolveSettings().url === "https://gw.lunaroute.com/v1/embeddings", mod.resolveSettings().url);
check("and is not marked as overridden", mod.resolveSettings().urlOverridden === false);
const envKey = process.env.DURABLE_MEMORY_EMBED_KEY;
delete process.env.DURABLE_MEMORY_EMBED_KEY;
const ALT_DIR = path.join(SCRATCH, "alt-store");
fs.writeFileSync(
	CONFIG,
	JSON.stringify({ endpoint: "local", url: "http://127.0.0.1:9999/v1/embeddings", model: "local-emb", apiKey: "cfg-secret", storeDir: ALT_DIR }),
	{ mode: 0o600 },
);
check("settings file is mode 0600", (fs.statSync(CONFIG).mode & 0o777) === 0o600, (fs.statSync(CONFIG).mode & 0o777).toString(8));
const s = mod.readSettings();
check("endpoint is read", s.endpoint === "local");
const resolved = mod.resolveSettings();
check("url is read", resolved.url === "http://127.0.0.1:9999/v1/embeddings", resolved.url);
check("a typed url counts as an override", resolved.urlOverridden === true);
check("model is read", resolved.model === "local-emb", resolved.model);
check("apiKey is read from the config", resolved.apiKey === "cfg-secret" && resolved.keySource === "config", resolved.keySource);
check("storeDir is read", resolved.storeDir === ALT_DIR, resolved.storeDir);
check("the store reopens at the configured directory", path.join(resolved.storeDir, "memory.db") === path.join(ALT_DIR, "memory.db"));

// env is the escape hatch and wins; the file wins over the default.
process.env.DURABLE_MEMORY_DIR = PROBE_STORE;
check("DURABLE_MEMORY_DIR beats the settings file", mod.resolveSettings().storeDir === PROBE_STORE, mod.resolveSettings().storeDir);
delete process.env.DURABLE_MEMORY_DIR;
process.env.DURABLE_MEMORY_EMBED_MODEL = "env-emb";
check("DURABLE_MEMORY_EMBED_MODEL beats the settings file", mod.resolveSettings().model === "env-emb");
delete process.env.DURABLE_MEMORY_EMBED_MODEL;
check("with no file the defaults apply and the file is recreated", (() => {
	fs.rmSync(CONFIG, { force: true });
	const d = mod.resolveSettings();
	return d.endpoint === "remote" && d.model === "emb-qwen3" && d.storeDir === mod.DEFAULT_STORE_DIR && fs.existsSync(CONFIG);
})());
// A url equal to the endpoint's own preset is the default, not an override — including one left in a
// config written by an earlier version, which stored the preset explicitly.
fs.writeFileSync(CONFIG, JSON.stringify({ endpoint: "remote", url: "https://gw.lunaroute.com/v1/embeddings" }), { mode: 0o600 });
check("a stored preset url is not an override", mod.resolveSettings().urlOverridden === false, JSON.stringify(mod.readSettings()));
check("debug true is read from the settings file", (() => {
	fs.writeFileSync(CONFIG, JSON.stringify({ debug: true }), { mode: 0o600 });
	return mod.resolveSettings().debug === true;
})());
let badDebug = false;
try {
	fs.writeFileSync(CONFIG, JSON.stringify({ debug: "yes" }), { mode: 0o600 });
	mod.readSettings();
} catch (e) {
	badDebug = /"debug" must be true or false/.test(e.message);
}
check("a non-boolean debug value fails loudly", badDebug);

// A malformed settings file must fail loudly rather than silently reverting to defaults.
fs.writeFileSync(CONFIG, "{ not json", { mode: 0o600 });
let badJson = false;
try {
	mod.readSettings();
} catch (e) {
	badJson = /config\.json/.test(e.message);
}
check("a malformed settings file fails loudly", badJson);
fs.writeFileSync(CONFIG, JSON.stringify({ storeDir: path.join(SCRATCH, "node_modules", "x") }), { mode: 0o600 });
let badDir = false;
try {
	mod.resolveSettings();
} catch (e) {
	badDir = /node_modules/.test(e.message) && /delete the store/.test(e.message);
}
check("a stored directory inside node_modules is refused", badDir);
fs.rmSync(CONFIG, { force: true });
if (envKey) process.env.DURABLE_MEMORY_EMBED_KEY = envKey;

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
check("status reports the auth-key source", /auth key:/.test(st), st);

// The endpoint row is a bare picker: no URL on the row, none on the options.
const seenSelections = [];
const editCtx = {
	...settingsCtx,
	ui: {
		...settingsCtx.ui,
		select: (() => {
			let call = 0;
			return async (_title, options) => {
				call++;
				seenSelections.push(options);
				if (call === 1) return options.find((o) => o.startsWith("Endpoint"));
				if (call === 2) return "local";
				return options[options.length - 1]; // "Done"
			};
		})(),
		input: async () => undefined,
	},
};
await captured.commands.get("durable-memory").handler("", editCtx);
check(
	"the endpoint row shows the endpoint and no url",
	seenSelections[0].includes("Endpoint        remote") && !seenSelections[0].some((o) => o.startsWith("Endpoint") && /https?:/.test(o)),
	JSON.stringify(seenSelections[0]),
);
check(
	"the url row shows the url that will be used",
	seenSelections[0].some((o) => o === "URL             https://gw.lunaroute.com/v1/embeddings"),
	JSON.stringify(seenSelections[0]),
);
check("the endpoint picker offers bare names, no urls", JSON.stringify(seenSelections[1]) === JSON.stringify(["remote", "local"]), JSON.stringify(seenSelections[1]));
const after = mod.readSettings();
check("choosing local writes endpoint=local", after.endpoint === "local", JSON.stringify(after));
check("choosing an endpoint leaves no url behind", after.url === undefined, JSON.stringify(after));
check("the resolved url is the local preset", mod.resolveSettings().url === "http://localhost:8080/v1/embeddings", mod.resolveSettings().url);
check("the settings file was created 0600", (fs.statSync(CONFIG).mode & 0o777) === 0o600);
fs.rmSync(CONFIG, { force: true });

// The URL row is where an override is authored, and blanking it hands control back to the preset.
// Start from a store configured for the local endpoint, so the preset under test is distinct.
fs.writeFileSync(CONFIG, JSON.stringify({ endpoint: "local" }), { mode: 0o600 });
const urlCtx = (typed) => ({
	...settingsCtx,
	ui: {
		...settingsCtx.ui,
		select: (() => {
			let call = 0;
			return async (_title, options) => {
				call++;
				if (call === 1) return options.find((o) => o.startsWith("URL"));
				return options[options.length - 1];
			};
		})(),
		input: async (_title, placeholder) => typed(placeholder),
	},
});
let urlPrefill = null;
await captured.commands.get("durable-memory").handler("", urlCtx((prefill) => ((urlPrefill = prefill), "http://127.0.0.1:7777/v1/embeddings")));
check("the url row is prefilled with the current endpoint's url", urlPrefill === "http://localhost:8080/v1/embeddings", String(urlPrefill));
check("a typed url becomes the override", mod.resolveSettings().url === "http://127.0.0.1:7777/v1/embeddings" && mod.resolveSettings().urlOverridden === true, mod.resolveSettings().url);
let overrideRows = [];
await captured.commands.get("durable-memory").handler("", {
	...settingsCtx,
	ui: {
		...settingsCtx.ui,
		select: async (_title, options) => ((overrideRows = options), options[options.length - 1]), // "Done"
	},
});
check(
	"an overridden url is shown with its value and marked",
	overrideRows.some((o) => o === "URL             http://127.0.0.1:7777/v1/embeddings (overridden)"),
	JSON.stringify(overrideRows),
);
await captured.commands.get("durable-memory").handler("", urlCtx(() => "  "));
check("a blank entry restores the preset", mod.readSettings().url === undefined && mod.resolveSettings().url === "http://localhost:8080/v1/embeddings", JSON.stringify(mod.readSettings()));
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
	await call({ action: "surface", query: "a query that should never reach the network" });
} catch (e) {
	refused = /node_modules/.test(e.message) && /would delete the store/.test(e.message);
}
check("a store path under node_modules makes the tool fail loudly", refused);
// Restoring an unset variable by assignment would set the string "undefined", so delete it.
if (goodDir === undefined) delete process.env.DURABLE_MEMORY_DIR;
else process.env.DURABLE_MEMORY_DIR = goodDir;

// ── 15. two stores: local writable, global read-only ─────────────
section("[15] a global store is merged into surface and never written");
const GLOBAL_DIR = path.join(SCRATCH, "global-store");
const GLOBAL_DB = path.join(GLOBAL_DIR, "memory.db");
const DEPLOY_QUERY = "Deploying from a clean checkout. The surrounding work: the shared deploy script and the forward-only postgres migrations it runs.";
const globalSnapshot = () => {
	const handle = new DatabaseSync(GLOBAL_DB, { readOnly: true });
	try {
		return JSON.stringify({
			rows: handle.prepare("SELECT id, body, emb, score, sessions, updated_at FROM memories ORDER BY id").all(),
			meta: handle.prepare("SELECT k, v FROM meta ORDER BY k").all(),
		});
	} finally {
		handle.close();
	}
};
const globalCount = () => {
	const handle = new DatabaseSync(GLOBAL_DB, { readOnly: true });
	try {
		return Number(handle.prepare("SELECT COUNT(*) AS n FROM memories").get().n);
	} finally {
		handle.close();
	}
};
const withGlobalMeta = (fn) => {
	const handle = new DatabaseSync(GLOBAL_DB);
	try {
		return fn(handle);
	} finally {
		handle.close();
	}
};
const restoreDir = (value) => {
	if (value === undefined) delete process.env.DURABLE_MEMORY_DIR;
	else process.env.DURABLE_MEMORY_DIR = value;
};

// Seed the shared corpus through the tool itself, with the real embedder, then remove the golden
// vector: a corpus seeded out of band carries none, and searching one must not add one.
const localDir = process.env.DURABLE_MEMORY_DIR;
process.env.DURABLE_MEMORY_DIR = GLOBAL_DIR;
await fire("session_shutdown");
const seeded = await mutate({
	create: ["Deploy scripts must run against a clean checkout.", "Postgres migrations in this project run forward only, never down."],
});
check("the shared corpus was seeded", seeded.details.report.created.length === 2);
withGlobalMeta((handle) => handle.prepare("DELETE FROM meta WHERE k = 'golden'").run());
const seededSnapshot = globalSnapshot();

restoreDir(localDir);
process.env.DURABLE_MEMORY_GLOBAL_DIR = GLOBAL_DIR;
await fire("session_shutdown");
// A local memory on the same topic, so both stores contribute and the labelling rule is exercised.
await mutate({ create: ["The deploy script needs a clean checkout, and its migrations only run forward."] });
const mergedText = textOf(await call({ action: "surface", query: DEPLOY_QUERY }));
check("both stores are searched and labelled", /\[global\]/.test(mergedText) && /\[local\]/.test(mergedText), mergedText.slice(0, 400));
check("the shared corpus is found", /clean checkout/i.test(mergedText), mergedText.slice(0, 400));
check("searching the global store did not write to it", globalSnapshot() === seededSnapshot, "global rows or meta changed");

await mutate({ create: ["A private memory written while a shared store was mounted."] });
check("a create went to the local store only", globalCount() === 2, `global rows: ${globalCount()}`);
check("a read-only store refuses a direct write", (() => {
	const ro = new MemoryStore(GLOBAL_DIR, { readOnly: true });
	try {
		ro.vote([{ id: "aaaa0000", helpful: true }]);
		return false;
	} catch (e) {
		return /read-only store/.test(e.message);
	} finally {
		ro.close();
	}
})());

// A corpus embedded with a different model cannot be searched, and must not be rewritten to fit.
withGlobalMeta((handle) => handle.prepare("UPDATE meta SET v = 'some-other-model' WHERE k = 'embedder'").run());
await fire("session_shutdown");
const mismatched = textOf(await call({ action: "surface", query: DEPLOY_QUERY }));
check("a mismatched corpus is skipped with its reason", /global store was skipped/.test(mismatched) && /not comparable/.test(mismatched), mismatched.slice(0, 300));
check("the local store still answers", /\[1\] id: [0-9a-f]{8}/.test(mismatched) && !/No store could be searched/.test(mismatched), mismatched.slice(0, 300));
check("and the mismatched corpus was left alone", withGlobalMeta((handle) => handle.prepare("SELECT k FROM meta WHERE k = 'golden'").get() === undefined));

delete process.env.DURABLE_MEMORY_GLOBAL_DIR;
await fire("session_shutdown");
const soloAgain = textOf(await call({ action: "surface", query: DEPLOY_QUERY }));
check("with the global store unmounted the labels disappear", !/\[local\]/.test(soloAgain) && !/\[global\]/.test(soloAgain), soloAgain.slice(0, 300));

// ── 16. LEGACY STORE MIGRATION — temporary; cut with its section in ../index.ts ──
section("[16] stores from every earlier release are migrated on open");
const KEY_BYTES = crypto.randomBytes(32);
const sealed = (text) => {
	const iv = crypto.randomBytes(12);
	const c = crypto.createCipheriv("aes-256-gcm", KEY_BYTES, iv);
	const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
	return Buffer.concat([iv, c.getAuthTag(), ct]); // iv(12) || tag(16) || ciphertext
};
const CURRENT_COLS = ["id", "body", "emb", "score", "sessions", "created_at", "updated_at"];

/**
 * Builds a store exactly as the named release left it. Three shapes ever shipped:
 *   0.1.0–0.2.0  dim + surfaces + pointers + meta('embedder')
 *   0.2.x–0.3.4  pointers + meta('embedder')
 *   0.3.5        current columns + meta('encrypted')
 * Every pre-0.3.5 store was encrypted and carried no mode row; the keyfile is the only evidence.
 */
function makeLegacyStore(dir, shape, { keyfile = true } = {}) {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	if (keyfile) fs.writeFileSync(path.join(dir, "memory.key"), KEY_BYTES, { mode: 0o600 });
	const db = new DatabaseSync(path.join(dir, "memory.db"));
	try {
		const deadColumns = shape === "0.1.0" ? "dim INTEGER NOT NULL, surfaces INTEGER NOT NULL DEFAULT 0," : "";
		db.exec(`
			CREATE TABLE memories (
				id TEXT PRIMARY KEY, body BLOB NOT NULL, emb BLOB NOT NULL, ${deadColumns}
				score REAL NOT NULL DEFAULT 0, sessions TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
		`);
		if (shape !== "0.3.5") {
			db.exec(`
				CREATE TABLE pointers (
					id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
					body BLOB NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL
				);
				CREATE INDEX pointers_memory ON pointers(memory_id);
			`);
			db.prepare("INSERT INTO meta (k, v) VALUES ('embedder', ?)").run("stub-model");
		} else {
			db.prepare("INSERT INTO meta (k, v) VALUES ('embedder', ?)").run("stub-model");
			db.prepare("INSERT INTO meta (k, v) VALUES ('encrypted', ?)").run("false");
		}
		const text = `a memory written by ${shape} that must survive the migration`;
		const vec = new Float32Array(1024).fill(0.01);
		// 0.3.5 stores can be unencrypted; every earlier shape always was.
		const body = shape === "0.3.5" ? Buffer.from(text, "utf8") : sealed(text);
		const sql = shape === "0.1.0"
			? "INSERT INTO memories (id, body, emb, dim, score, sessions, created_at, updated_at) VALUES (?,?,?,1024,0,'[]',1,1)"
			: "INSERT INTO memories (id, body, emb, score, sessions, created_at, updated_at) VALUES (?,?,?,0,'[]',1,1)";
		db.prepare(sql).run("aaaa7777", body, Buffer.from(vec.buffer));
		if (shape !== "0.3.5") {
			db.prepare("INSERT INTO pointers (id, memory_id, body, session_id, created_at) VALUES (?,?,?,?,?)")
				.run("pppp7777", "aaaa7777", sealed("an orphaned note"), "sess-legacy", 1);
		}
	} finally {
		db.close();
	}
	return dir;
}

function inspect(dir) {
	const db = new DatabaseSync(path.join(dir, "memory.db"), { readOnly: true });
	try {
		return {
			columns: db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name),
			tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name),
			mode: db.prepare("SELECT v FROM meta WHERE k = 'encrypted'").get()?.v,
			rows: Number(db.prepare("SELECT COUNT(*) AS n FROM memories").get().n),
		};
	} finally {
		db.close();
	}
}

for (const shape of ["0.1.0", "0.3.0", "0.3.5"]) {
	const dir = makeLegacyStore(path.join(SCRATCH, `legacy-${shape}`), shape);
	const before = inspect(dir);
	const store = new MemoryStore(dir);
	const after = inspect(dir);
	const legacy = shape !== "0.3.5";

	check(`[${shape}] columns normalised to the current schema`, JSON.stringify(after.columns) === JSON.stringify(CURRENT_COLS), after.columns.join(","));
	check(`[${shape}] the dead columns are gone`, !after.columns.includes("dim") && !after.columns.includes("surfaces"), after.columns.join(","));
	check(`[${shape}] the orphan pointers table is gone`, !after.tables.includes("pointers"), after.tables.join(","));
	if (legacy) {
		check(`[${shape}] the mode row is backfilled from the keyfile`, before.mode === undefined && after.mode === "true", `before ${before.mode} after ${after.mode}`);
		check(`[${shape}] the store reports itself encrypted`, store.encrypted === true);
	} else {
		check(`[${shape}] an existing mode row is left alone`, after.mode === "false", String(after.mode));
	}
	let found = null;
	let err = null;
	try {
		found = await store.surface("a memory written before the migration that must survive");
	} catch (e) {
		err = e.message;
	}
	// The rows predate this session, so their vectors are re-embedded and their bodies must decode.
	check(`[${shape}] a pre-existing row still reads back`, err === null && found?.hits.some((h) => h.id === "aaaa7777"), err ?? JSON.stringify(found?.hits.map((h) => h.id)));
	let wrote = null;
	try {
		wrote = (await store.create([`a memory written after the ${shape} migration`], "sess-now")).length === 1;
	} catch (e) {
		wrote = e.message;
	}
	check(`[${shape}] the migrated store takes writes`, wrote === true, String(wrote));
	check(`[${shape}] every row survived`, inspect(dir).rows === before.rows + 1, `${before.rows} -> ${inspect(dir).rows}`);
	store.close();

	// Opening again must change nothing: the migration is idempotent on an already-current store.
	const again = new MemoryStore(dir);
	const twice = inspect(dir);
	check(`[${shape}] a second open changes no schema`, JSON.stringify(twice.columns) === JSON.stringify(after.columns) && JSON.stringify(twice.tables) === JSON.stringify(after.tables), JSON.stringify(twice));
	check(`[${shape}] and keeps the mode it recorded`, twice.mode === after.mode, `${after.mode} -> ${twice.mode}`);
	again.close();
}

// A pre-0.3.5 store never had a mode row, so a keyfile alone means encrypted — even with no rows,
// which the old sample-decrypt check could not tell apart from an unencrypted store.
const EMPTY_LEGACY = makeLegacyStore(path.join(SCRATCH, "legacy-empty"), "0.3.0");
{
	const handle = new DatabaseSync(path.join(EMPTY_LEGACY, "memory.db"));
	try {
		handle.exec("DELETE FROM memories; DELETE FROM pointers;");
	} finally {
		handle.close();
	}
}
check("an empty legacy store with a keyfile is still encrypted", new MemoryStore(EMPTY_LEGACY).encrypted === true);

// A 0.3.5 store switched off keeps its keyfile; the recorded mode wins, so it must stay unencrypted.
const SWITCHED_OFF = makeLegacyStore(path.join(SCRATCH, "legacy-switched-off"), "0.3.5");
check("a 0.3.5 store that was switched off stays unencrypted despite its keyfile", new MemoryStore(SWITCHED_OFF).encrypted === false);

// Leave no scratch stores behind on a clean run; keep them on failure so they can be inspected.
if (failures === 0) {
	for (const dir of [SCRATCH, SCRATCH3]) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
