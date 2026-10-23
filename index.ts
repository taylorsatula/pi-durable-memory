/**
 * Registers the `durable_memory` tool — long-term memory across pi sessions — and the
 * `/durable-memory` command for configuration and status. A session opens with `action: "surface"`
 * (a distill of the work) and records each completed task with `action: "checkpoint"`, which returns
 * fixed checkpoint instructions (create/rate/edit) batched into one `action: "mutate"` call, also
 * fired after a commit.
 *
 * `action` is a strict dispatcher — required, and each call may carry only the arguments that
 * belong to its action; anything else is rejected rather than ignored or applied. So a write can
 * only ever come from a call that said `mutate`, and a reply can only ever come from the action
 * that owns it.
 *
 * Alongside the memories sits a per-file ledger: one short note per file a session edited or wrote,
 * keyed by repository and relative path, never embedded, and read back only when `action: "ledger"` names
 * the file.
 *
 * Two stores can be active: the local one, always present and writable, and an optional global one
 * seeded out of band and merged into `surface` read-only. Mutations only ever reach the local store.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ── Settings ──────────────────────────────────────────────────────

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

/** Outside everything pi reconciles: a store beside index.ts is deleted by `pi update --extensions`. */
const DEFAULT_STORE_DIR = path.join(AGENT_DIR, "durable-memory");

/** Fixed, so that moving the store does not move the settings. */
const CONFIG_PATH = path.join(DEFAULT_STORE_DIR, "config.json");

/** Each endpoint has one canonical URL; that preset is the default, and the file only names a URL to override it. */
const URLS = {
	remote: "https://gw.lunaroute.com/v1/embeddings",
	local: "http://localhost:8080/v1/embeddings",
};
type Endpoint = keyof typeof URLS;
const ENDPOINTS = Object.keys(URLS) as Endpoint[];

/** Every setting has a value here; a missing config file is prefilled with them. `url` is absent by design — it inherits the endpoint's preset until overridden. */
const DEFAULTS = {
	endpoint: "remote" as Endpoint,
	model: "emb-qwen3",
	storeDir: DEFAULT_STORE_DIR,
	debug: false,
} satisfies Settings;

const KEYS = ["endpoint", "url", "model", "apiKey", "storeDir", "globalStoreDir", "debug"] as const;
type Key = (typeof KEYS)[number];

interface Settings {
	endpoint?: Endpoint;
	url?: string;
	model?: string;
	apiKey?: string;
	storeDir?: string;
	globalStoreDir?: string;
	/** Off by default; on, every surface query, its hits, and every rating land in a separate debug db. */
	debug?: boolean;
}

/** Settings with every default filled in — the shape the file has once prefilled. */
type Resolved = Settings & typeof DEFAULTS;

/**
 * The file is operator-editable, so a wrong type, an unknown endpoint, or a stray key fails here
 * with the path in the message — not later, as a fetch error against a malformed URL.
 */
function checkedSettings(parsed: unknown): Settings {
	if (typeof parsed !== "object" || parsed === null) throw new Error(`${CONFIG_PATH}: expected a JSON object.`);
	const raw = parsed as Record<string, unknown>;
	const unknown = Object.keys(raw).filter((k) => !(KEYS as readonly string[]).includes(k));
	if (unknown.length) {
		throw new Error(`${CONFIG_PATH}: unknown setting${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}.`);
	}
	const out: Record<string, string | boolean> = {};
	for (const key of KEYS) {
		const value = raw[key];
		if (value === undefined) continue; // absent means "take the default", not "clear it"
		if (key === "debug") {
			if (typeof value !== "boolean") {
				throw new Error(`${CONFIG_PATH}: "debug" must be true or false, got ${typeof value}.`);
			}
			out.debug = value;
			continue;
		}
		if (typeof value !== "string") throw new Error(`${CONFIG_PATH}: "${key}" must be a string, got ${typeof value}.`);
		out[key] = value;
	}
	if (out.endpoint && !(out.endpoint in URLS)) {
		throw new Error(`${CONFIG_PATH}: endpoint "${out.endpoint}" is not one of ${Object.keys(URLS).join(", ")}.`);
	}
	return out as Settings;
}

/** Reads the settings file, prefilling it with the defaults on first run so every key is visible and editable. */
function readSettings(): Resolved {
	if (!fs.existsSync(CONFIG_PATH)) {
		writeSettings(DEFAULTS);
		return { ...DEFAULTS };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch (err) {
		throw new Error(`${CONFIG_PATH}: ${(err as Error).message}`);
	}
	return { ...DEFAULTS, ...checkedSettings(parsed) };
}

function writeSettings(settings: Settings): void {
	fs.mkdirSync(DEFAULT_STORE_DIR, { recursive: true, mode: 0o700 });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(CONFIG_PATH, 0o600);
}

/** Broad constraint: the store must outlive package reinstalls, and node_modules is where it cannot. */
function assertStoreDir(dir: string): string {
	if (dir.split(path.sep).includes("node_modules")) {
		throw new Error(
			`${dir} is inside node_modules, where a package update would delete the store. ` +
				`Choose a directory outside any installed package, or use the default ${DEFAULT_STORE_DIR}.`,
		);
	}
	return dir;
}

/** Env over the config file — two layers, nothing else. */
function resolveSettings() {
	const s = readSettings();
	const fromEnv = process.env.DURABLE_MEMORY_EMBED_KEY;
	const globalDir = process.env.DURABLE_MEMORY_GLOBAL_DIR ?? s.globalStoreDir;
	// A stored URL equal to the endpoint's own preset is not an override, so it reads as the default.
	const override = s.url && s.url !== URLS[s.endpoint] ? s.url : undefined;
	const fromEnvUrl = process.env.DURABLE_MEMORY_EMBED_URL;
	return {
		endpoint: s.endpoint,
		url: fromEnvUrl ?? override ?? URLS[s.endpoint],
		urlOverridden: Boolean(fromEnvUrl ?? override),
		model: process.env.DURABLE_MEMORY_EMBED_MODEL ?? s.model,
		apiKey: fromEnv ?? s.apiKey,
		keySource: fromEnv ? "env" : s.apiKey ? "config" : "none",
		storeDir: assertStoreDir(process.env.DURABLE_MEMORY_DIR ?? s.storeDir),
		globalStoreDir: globalDir ? assertStoreDir(globalDir) : undefined,
		debug: s.debug === true || process.env.DURABLE_MEMORY_DEBUG === "1",
	};
}

// ── Tuning ───────────────────────────────────────────────────────────

/** Attention-sink marker. Rare enough that it does not occur in ordinary prose. */
const MARK = "⟁";

/**
 * Measured on `emb-qwen3` over the 35-memory benchmark in `bench/` (queries share no content
 * words with their targets, so the numbers are semantic, not lexical). 0.44 clears the
 * off-topic peak (0.408) and the weakest on-topic match (0.477) by ~0.035; recall is flat in
 * the floor from 0.30–0.49 — the floor rejects off-topic work, it does not tune precision.
 * K=8 is the knee: recall plateaus there, precision decays beyond it.
 * Re-run `bench/sweep.mjs` after changing the embedding model — these are model-specific.
 */
const MIN_COSINE = 0.44;
const TOP_K = 8;

/** Golden string used to detect embedding-model mismatch. */
const GOLDEN_TEXT = "I have information that will lead to the arrest of Dario Amodei";

/** DECLINED-ALTERNATIVE: hubness correction. +0.11 MRR on terse queries but +0.003 once the distill names the machinery, at O(n²·dim) per query. Revisit past a few thousand rows. */
const VOTE_STEP = 0.5;
const SCORE_WEIGHT = 0.05;
const SCORE_INFLUENCE_CAP = 0.25;

/** A ledger note is one short sentence; past this it is a commit message, and the commit already has one. */
const NOTE_MAX = 200;
/** A file touched every session grows without bound, so `ledger` shows the newest notes and counts the rest. */
const LEDGER_TAIL = 20;

/** The action enum is the whole dispatch surface: retrieve, get instructions, write, read a file's ledger. */
const ACTIONS = ["surface", "checkpoint", "mutate", "ledger"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Returned verbatim on every `checkpoint` call. Task-scoped, not session-scoped: a model cannot
 * observe "the session is ending", but it can observe "the task is done".
 *
 * Directive v2 (shipped 0.4.0), rewritten against the first real corpus — the commit that touched
 * this line carries the full evolution record and the protocol for the next prompt revision.
 */
const CHECKPOINT_MESSAGE = [
	`${rule()} CHECKPOINT — RECORD WHAT YOU LEARNED ${rule()}`,
	"",
	"You just completed a unit of work. Batch the following into ONE `durable_memory` call with",
	'`action: "mutate"`:',
	"",
	"1. `create` — facts no readable text supplies. One self-contained sentence per fact: a",
	"   gnomic-present stative proposition — what IS, never what happened; events culminate and rot,",
	"   states hold until refuted, and the aspect is the shelf life.",
	"",
	"   Endophorically complete: no deixis, no exophora — the session that wrote it no longer exists",
	"   at retrieval time. Rigidly designated: paths, error strings, proper nouns, numerals — never",
	"   hypernyms or quantified generics. Paratactically extended, not subordinated: fact and context",
	"   as one embedding unit with two retrieval surfaces. The theme names where it fires — the file,",
	"   command, or decision moment that will need this memory.",
	"",
	"   Not entailed by any accessible text: what the repo, docstrings, or this tool's instructions",
	"   say, they say better, and a second copy diverges. Carry the verification condition — the",
	"   checkable path, string, or command whose change proves the row stale; an unfalsifiable row",
	"   is a belief.",
	"",
	"   The negative, never: a perfective event report — exophoric, deictic, hedged, autological,",
	"   duplicated, or entailed — culminated work with no next time and no killer. Two tests before",
	"   recording: WHEN does this next fire, WHAT kills it? Either unanswered — no call. Where a",
	"   surfaced id already carries the fact, `edit` it rather than `create` a second one; a ruling",
	"   that contradicts an existing row edits that row; never append a duplicate beside it.",
	"",
	"2. `helpful` — rate every id `surface` showed you and you have not rated: `true` if it changed what",
	"   you did, `false` if it did not. Ratings decide what surfaces next; guess rather than skip.",
	"",
	"3. `edit` / `delete` — correct what is wrong, remove what is dead.",
	"",
	"4. `annotate` — one `{path, note}` per file you edited or wrote since the last checkpoint, the path",
	"   relative to the working directory. The note is one short sentence on how this work touched that",
	'   file: "fixed the cursor off-by-one introduced in a3f9c21", "touched as part of feature wwvk".',
	"   Notes are a per-file ledger read back by path, never a memory, so the event report the rule in 1",
	"   forbids is exactly what a note is.",
	"",
	"`action` selects what a call does, and an argument that does not belong to it is rejected — so every",
	"array above rides in the `mutate` call, applied in the order delete, edit, create, annotate, helpful:",
	"delete first, so never delete and edit the same id in one call.",
	"",
	"Example:",
	'   { "action": "mutate", "create": ["..."], "annotate": [{"path":"src/pager.ts","note":"..."}], "helpful": [{"id":"a1b2c3d4","helpful":true}] }',
	"",
	"If there is nothing to send, send nothing — never another `checkpoint`, which returns this message",
	"and records nothing, and never an empty `mutate`, which is rejected. Mutations sent with any other",
	"action are rejected too — resend them as `action: \"mutate\"`.",
	"",
	"The next task begins with `action: \"surface\"`; call `action: \"checkpoint\"` again when it is complete,",
	"and after every commit.",
].join("\n");

function rule(width = 5): string {
	return MARK.repeat(width);
}

// ── Release notes ───────────────────────────────────────────────

/**
 * Per-version notes pushed to the user on the session starts after that version installs. Keyed by
 * package version — `announced.txt` records a show count per version, so skipping a release still
 * delivers its note, and a delivered note never fires again.
 *
 * The notes live in release-notes.json beside index.ts, so index.ts does not bloat as notes
 * accumulate across releases. A load with no file beside it (a vendored copy of index.ts alone)
 * announces nothing; a file that is present but malformed fails loudly rather than announcing
 * nothing silently.
 */
const RELEASE_NOTES: Record<string, string> = (() => {
	const notesPath = new URL("./release-notes.json", import.meta.url);
	if (!fs.existsSync(notesPath)) return {};
	const parsed: unknown = JSON.parse(fs.readFileSync(notesPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`release-notes.json: expected a JSON object of version -> note.`);
	}
	for (const [version, note] of Object.entries(parsed)) {
		if (typeof note !== "string") {
			throw new Error(`release-notes.json: the note for "${version}" must be a string, got ${typeof note}.`);
		}
	}
	return Object.fromEntries(Object.entries(parsed) as Array<[string, string]>);
})();

/** Orders dotted numeric versions ascending; anything unparsable sorts last, and notes never name one. */
function compareVersions(a: string, b: string): number {
	const pad = (s: string) => s.split(".").map((n) => Number(n) || 0);
	const [x, y] = [pad(a), pad(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

/** Per-version show counts ("0.4.1 2\n0.4.2 1"), beside config.json. A single line from an older release still parses. */
const ANNOUNCED_PATH = path.join(DEFAULT_STORE_DIR, "announced.txt");

/** A session-start toast is easy to miss once, so a version's note shows on the first two interactive loads. */
const ANNOUNCES_PER_VERSION = 2;

// ── Encryption ───────────────────────────────────────────────────────

/** AES-256-GCM. Layout: iv(12) || tag(16) || ciphertext. */
function encrypt(key: Buffer, plaintext: string): Buffer {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decrypt(key: Buffer, blob: Uint8Array): string {
	const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
	decipher.setAuthTag(buf.subarray(12, 28));
	return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/** 0600, and an explicit chmod because writeFileSync's mode is masked by umask and ignores an existing file's. */
function writeKey(keyPath: string, key: Buffer): void {
	fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(keyPath, key, { mode: 0o600 });
	fs.chmodSync(keyPath, 0o600);
}

/** Creates the store directory if absent (0700) and the keyfile on first use (0600). */
function loadKey(keyPath: string): Buffer {
	if (fs.existsSync(keyPath)) {
		const raw = fs.readFileSync(keyPath);
		if (raw.length !== 32) throw new Error(`${keyPath} is ${raw.length} bytes, expected 32. Delete it to regenerate.`);
		return raw;
	}
	const key = crypto.randomBytes(32);
	writeKey(keyPath, key);
	return key;
}

// ── Embeddings ───────────────────────────────────────────────────────

const EMBED_TIMEOUT_MS = 30_000;

/** OpenAI-compatible /embeddings. Throws on any non-2xx or malformed response — no silent zeros. */
async function embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
	if (texts.length === 0) return [];
	const cfg = resolveSettings(); // per call, so settings changes take effect without a restart
	if (!cfg.apiKey && cfg.endpoint !== "local") {
		throw new Error(
			`No embedding credential for ${cfg.url}. Run /durable-memory to set an auth key, or set ` +
				`DURABLE_MEMORY_EMBED_KEY, or switch the endpoint to local.`,
		);
	}

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
	const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
	const res = await fetch(cfg.url, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: cfg.model, input: texts }),
		// The caller's signal too: aborting a turn should stop the embedding request, not just its rendering.
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const body = await res.text();
	if (!res.ok) {
		throw new Error(`Embedding request failed: HTTP ${res.status} from ${cfg.url} — ${body.slice(0, 300)}`);
	}

	const data = (JSON.parse(body) as { data?: Array<{ index: number; embedding: number[] }> }).data;
	if (!Array.isArray(data) || data.length !== texts.length) {
		throw new Error(`Embedding response returned ${data?.length ?? 0} vectors for ${texts.length} inputs.`);
	}
	// Key by the returned index, never array position: the provider may reorder.
	const byIndex = new Map(data.map((item) => [item.index, Float32Array.from(item.embedding)]));
	return texts.map((_, i) => {
		const vec = byIndex.get(i);
		if (!vec?.length) throw new Error(`Embedding for input ${i} was missing or empty.`);
		return vec;
	});
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

// ── Store ────────────────────────────────────────────────────────────

function toBlob(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

type SqlValue = null | number | bigint | string | Uint8Array;

interface MemoryRow {
	id: string;
	body: Uint8Array;
	emb: Uint8Array;
	score: number;
	sessions: string;
}

interface SurfaceHit {
	id: string;
	text: string;
	score: number;
	similarity: number;
	/** Similarity plus the helpfulness influence: the one ordering key, comparable across stores. */
	rank: number;
	/** Newest stamp in the provenance chain — the session that last wrote this memory, if it is stamped. */
	session: string | undefined;
	/** How many sessions have touched it. */
	stamps: number;
}

/** The stores a session can search: the writable local one, plus an optional seeded global one. */
interface Stores {
	local: MemoryStore;
	global?: MemoryStore;
}

// ── LEGACY STORE MIGRATION — temporary, cut whole ─────────────────────
/**
 * Brings a store written by any release before 0.3.5 up to the current shape. Three shapes ever
 * existed and this handles all of them:
 *
 *   0.1.0–0.2.0  dim, surfaces, pointers, meta('embedder')       — always encrypted, no mode row
 *   0.2.x–0.3.4  pointers, meta('embedder')                      — always encrypted, no mode row
 *   0.3.5+       current columns, meta('encrypted')              — already current
 *
 * Every pre-0.3.5 release encrypted unconditionally and recorded no mode, so a store lacking the
 * `encrypted` key is read from its keyfile: present and 32 bytes means encrypted. (A 0.3.5 store
 * switched off keeps its keyfile but carries the mode, so it never takes this path.)
 *
 * Idempotent, and cheap on a current store: three schema reads and one meta read. Delete this
 * function and its one call in the MemoryStore constructor a few weeks after 0.3.5, once old stores
 * are out of circulation.
 */
function migrateLegacyStore(db: DatabaseSync, dir: string): void {
	const columns = (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
	// 0.2.0 dropped both columns but every store created before it still declares them. Neither held
	// anything irreplaceable: `surfaces` was an occurred-count and `dim` is `length(emb) / 4`. `dim`
	// was NOT NULL with no default, so leaving it would fail every insert into such a store.
	for (const dead of ["dim", "surfaces"]) {
		if (columns.includes(dead)) db.exec(`ALTER TABLE memories DROP COLUMN ${dead}`);
	}
	// The pointer op is gone, so its rows are unreachable — and switchEncryption no longer rewrites
	// them, which would leave undecryptable bodies behind in a table nothing reads.
	if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pointers'").get()) {
		db.exec("DROP INDEX IF EXISTS pointers_memory; DROP TABLE pointers;");
	}
	// Record the mode these stores never had, so the running code reads it instead of guessing.
	if (!db.prepare("SELECT v FROM meta WHERE k = 'encrypted'").get()) {
		const keyPath = path.join(dir, "memory.key");
		const encrypted = fs.existsSync(keyPath) && fs.statSync(keyPath).size === 32;
		db.prepare("INSERT INTO meta (k, v) VALUES ('encrypted', ?)").run(String(encrypted));
	}
}
// ── END LEGACY STORE MIGRATION ────────────────────────────────────────

export class MemoryStore {
	private db: DatabaseSync;
	private key: Buffer | null;
	/** Set once this session has confirmed the stored vectors match the configured model. */
	private vectorsChecked = false;
	readonly dir: string;
	/** A read-only store is searched and never written: no migration, no re-embedding, no mode switch. */
	readonly readOnly: boolean;
	encrypted: boolean;

	constructor(dir: string, opts: { readOnly?: boolean } = {}) {
		this.dir = dir;
		this.readOnly = opts.readOnly === true;
		// A writable store owns its directory: create it, and keep it owner-only like the keyfile.
		if (!this.readOnly) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path.join(dir, "memory.db"));
		this.db.exec("PRAGMA busy_timeout = 5000;");
		if (this.readOnly) {
			// Seeded out of band, so it is opened exactly as it stands: no WAL switch, no schema write.
			for (const table of ["memories", "meta"]) {
				if (!this.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)) {
					throw new Error(
						`${dir} holds no memory database (missing "${table}"). Seed it with scripts/seed-global.mjs — see docs/global-store.md.`,
					);
				}
			}
		} else {
			this.db.exec(`
				PRAGMA journal_mode = WAL;
				CREATE TABLE IF NOT EXISTS memories (
					id         TEXT PRIMARY KEY,
					body       BLOB NOT NULL,
					emb        BLOB NOT NULL,
					score      REAL NOT NULL DEFAULT 0,
					sessions   TEXT NOT NULL DEFAULT '[]',
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS annotations (
					id         INTEGER PRIMARY KEY,
					repo       TEXT NOT NULL,
					path       TEXT NOT NULL,
					body       BLOB NOT NULL,
					session    TEXT NOT NULL,
					created_at INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS annotations_path ON annotations (repo, path, created_at);
			`);
			migrateLegacyStore(this.db, dir); // LEGACY MIGRATION — remove with its section
		}

		// Migration records the mode on any pre-0.3.5 store, so this is a plain read. A read-only store
		// was seeded out of band and is never written, so its mode comes from whoever seeded it.
		this.encrypted = this.one<{ v: string }>("SELECT v FROM meta WHERE k = 'encrypted'")?.v === "true";
		this.key = this.encrypted ? loadKey(path.join(dir, "memory.key")) : null;
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// Reload, session replacement, and process exit all converge here.
		}
	}

	private newId(): string {
		for (let attempt = 0; attempt < 20; attempt++) {
			const id = crypto.randomBytes(4).toString("hex");
			if (!this.one("SELECT 1 FROM memories WHERE id = ?", id)) return id;
		}
		throw new Error("Could not allocate a free memory id after 20 attempts.");
	}

	/** node:sqlite hands back untyped rows; these two keep the casts in one place. */
	private all<T>(sql: string, ...args: SqlValue[]): T[] {
		return this.db.prepare(sql).all(...args) as T[];
	}

	private one<T>(sql: string, ...args: SqlValue[]): T | undefined {
		return this.db.prepare(sql).get(...args) as T | undefined;
	}

	/** The embedder whose vectors live in this DB. A changed model means incomparable vectors. */
	embedder(): string | undefined {
		return this.one<{ v: string }>("SELECT v FROM meta WHERE k = 'embedder'")?.v;
	}

	private setMeta(k: string, v: string): void {
		this.db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
	}

	count(): number {
		return Number(this.one<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM memories")?.n ?? 0);
	}

	/** A seeded global store predates the ledger and may lack its table, so absence reads as zero. */
	annotationCount(): number {
		if (!this.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'annotations'")) return 0;
		return Number(this.one<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM annotations")?.n ?? 0);
	}

	/**
	 * Vectors are comparable only within one embedding model, and the same model varies slightly
	 * across runs — so the model name is the truth, never vector comparison. When it differs from
	 * the configured model, every embedding is regenerated.
	 *
	 * Runs at most once per store instance, which is once per pi session: the check costs an
	 * embedding round trip and its answer cannot change mid-session. A failure leaves the flag unset,
	 * so the next call tries again rather than silently searching mismatched vectors.
	 */
	private async ensureEmbeddings(signal?: AbortSignal): Promise<void> {
		if (this.vectorsChecked) return;
		const model = resolveSettings().model;
		const [golden] = await embed([GOLDEN_TEXT], signal);
		if (this.embedder() !== model || this.goldenDrifted(golden)) {
			const rows = this.all<{ id: string; body: Uint8Array }>("SELECT id, body FROM memories");
			const vectors = await embed(rows.map((row) => this.decode(row.body)), signal);
			// Vectors only: re-embedding is not an edit, and updated_at is rendered as authorship.
			const update = this.db.prepare("UPDATE memories SET emb = ? WHERE id = ?");
			this.transaction(() => {
				rows.forEach((row, i) => update.run(toBlob(vectors[i]), row.id));
				this.setMeta("embedder", model);
				this.setMeta("golden", JSON.stringify({ text: GOLDEN_TEXT, vec: Array.from(golden) }));
			});
		}
		this.vectorsChecked = true;
	}

	/** A stored golden vector that no longer reproduces means the model moved underneath its own name. */
	private goldenDrifted(golden: Float32Array): boolean {
		const stored = this.one<{ v: string }>("SELECT v FROM meta WHERE k = 'golden'");
		if (!stored) return true;
		try {
			const { vec } = JSON.parse(stored.v) as { vec: number[] };
			return cosine(golden, new Float32Array(vec)) < 0.999;
		} catch {
			return true;
		}
	}

	/**
	 * A read-only store's vectors belong to whoever seeded it, so regenerating them is not an option:
	 * a model mismatch is reported and the store is skipped instead.
	 */
	private assertVectorsComparable(): void {
		const written = this.embedder();
		const model = resolveSettings().model;
		if (written && written !== model) {
			throw new Error(
				`${this.dir} was embedded with "${written}" but this session uses "${model}", and vectors from ` +
					`different models are not comparable. Re-seed it with "${model}" to search it.`,
			);
		}
	}

	/** Every mutation goes through here: a read-only store is searched, never written. */
	private assertWritable(): void {
		if (this.readOnly) throw new Error(`${this.dir} is a read-only store; only the local store takes writes.`);
	}

	/** Runs `body` in one transaction, so a batch is all-or-nothing rather than half-applied. */
	private transaction<T>(body: () => T): T {
		this.db.exec("BEGIN");
		try {
			const out = body();
			this.db.exec("COMMIT");
			return out;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	async create(texts: string[], sessionId: string, signal?: AbortSignal): Promise<Array<{ id: string; text: string }>> {
		this.assertWritable();
		const clean = texts.map((t) => t.trim()).filter((t) => t.length > 0);
		if (clean.length === 0) return [];
		await this.ensureEmbeddings(signal);
		const vectors = await embed(clean, signal); // one HTTP round trip for the whole batch
		const now = Date.now();
		const insert = this.db.prepare(
			"INSERT INTO memories (id, body, emb, score, sessions, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
		);
		return this.transaction(() => {
			const created: Array<{ id: string; text: string }> = [];
			for (let i = 0; i < clean.length; i++) {
				const id = this.newId();
				insert.run(id, this.encode(clean[i]), toBlob(vectors[i]), JSON.stringify([sessionId]), now, now);
				created.push({ id, text: clean[i] });
			}
			return created;
		});
	}

	async edit(items: Array<{ id: string; text: string }>, sessionId: string, signal?: AbortSignal): Promise<string[]> {
		this.assertWritable();
		// Every id is checked before anything is written, so a bad one cannot leave a half-applied batch.
		const rows = items.map((item) => {
			const row = this.findById(item.id);
			if (!row) throw new Error(`edit: no memory with id "${item.id}".`);
			const text = item.text.trim();
			if (!text) throw new Error(`edit: replacement text for "${item.id}" was empty.`);
			return { row, text };
		});
		const vectors = await embed(rows.map((r) => r.text), signal); // one HTTP round trip for the whole batch
		const update = this.db.prepare("UPDATE memories SET body = ?, emb = ?, sessions = ?, updated_at = ? WHERE id = ?");
		return this.transaction(() => {
			rows.forEach(({ row, text }, i) => {
				const stamps = parseStamps(row.sessions);
				const chain = stamps[stamps.length - 1] === sessionId ? stamps : [...stamps, sessionId];
				update.run(this.encode(text), toBlob(vectors[i]), JSON.stringify(chain), Date.now(), row.id);
			});
			return rows.map((r) => r.row.id);
		});
	}

	delete(ids: string[]): string[] {
		this.assertWritable();
		const missing = ids.filter((id) => !this.findById(id));
		if (missing.length) {
			throw new Error(`delete: no memory with id ${missing.map((id) => `"${id}"`).join(", ")}.`);
		}
		const stmt = this.db.prepare("DELETE FROM memories WHERE id = ?");
		return this.transaction(() => {
			for (const id of ids) stmt.run(id);
			return ids;
		});
	}

	/** true moves a memory up future rankings, false sinks it toward silt. */
	vote(items: Array<{ id: string; helpful: boolean }>): Array<{ id: string; delta: number; missing: boolean }> {
		this.assertWritable();
		const out: Array<{ id: string; delta: number; missing: boolean }> = [];
		const bump = this.db.prepare("UPDATE memories SET score = score + ?, updated_at = ? WHERE id = ?");
		for (const item of items) {
			const row = this.findById(item.id);
			const delta = item.helpful ? VOTE_STEP : -VOTE_STEP;
			// An unknown id is reported, not thrown: ratings arrive from earlier sessions and may be stale.
			if (!row) {
				out.push({ id: item.id, delta, missing: true });
				continue;
			}
			bump.run(delta, Date.now(), row.id);
			out.push({ id: row.id, delta, missing: false });
		}
		return out;
	}

	/** Explicitly switch encryption mode. Generates a key on first switch to encrypted. */
	switchEncryption(target: boolean): void {
		this.assertWritable();
		if (target === this.encrypted) return;
		// Switching on with no key yet: generate it first, so a failed rewrite leaves the store as it
		// was and the key is already on disk for the retry.
		const key = this.key ?? crypto.randomBytes(32);
		if (!this.key) writeKey(path.join(this.dir, "memory.key"), key);
		const wasEncrypted = this.encrypted;
		this.transaction(() => {
			const rows = this.all<{ id: string; body: Uint8Array }>("SELECT id, body FROM memories");
			const update = this.db.prepare("UPDATE memories SET body = ? WHERE id = ?");
			for (const row of rows) {
				const text = wasEncrypted ? decrypt(key, row.body) : Buffer.from(row.body).toString("utf8");
				update.run(target ? encrypt(key, text) : Buffer.from(text, "utf8"), row.id);
			}
			// Ledger notes are bodies too; their paths stay in the clear, like vectors, because lookup needs them.
			const notes = this.all<{ id: number; body: Uint8Array }>("SELECT id, body FROM annotations");
			const updateNote = this.db.prepare("UPDATE annotations SET body = ? WHERE id = ?");
			for (const note of notes) {
				const text = wasEncrypted ? decrypt(key, note.body) : Buffer.from(note.body).toString("utf8");
				updateNote.run(target ? encrypt(key, text) : Buffer.from(text, "utf8"), note.id);
			}
			this.setMeta("encrypted", String(target));
		});
		this.encrypted = target;
		this.key = target ? key : null;
	}

	private encode(text: string): Buffer {
		if (!this.encrypted || !this.key) return Buffer.from(text, "utf8");
		return encrypt(this.key, text);
	}

	private decode(blob: Uint8Array): string {
		const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
		if (!this.encrypted || !this.key) return buf.toString("utf8");
		return decrypt(this.key, buf);
	}

	private findById(id: string): MemoryRow | undefined {
		return this.one<MemoryRow>("SELECT id, body, emb, score, sessions FROM memories WHERE id = ?", id);
	}

	/** Append-only: a ledger records how a file was touched, so a later note never rewrites an earlier one. */
	annotate(repo: string, items: Array<{ path: string; note: string }>, sessionId: string): Array<{ path: string; note: string }> {
		this.assertWritable();
		// Every note is checked before anything is written, so a bad one cannot leave a half-applied batch.
		const clean = items.map((item) => {
			const note = item.note.trim();
			if (!note) throw new Error(`annotate: the note for "${item.path}" was empty.`);
			if (/[\r\n]/.test(note) || note.length > NOTE_MAX) {
				throw new Error(`annotate: the note for "${item.path}" must be one line of at most ${NOTE_MAX} characters — one short sentence.`);
			}
			return { path: item.path, note };
		});
		const insert = this.db.prepare("INSERT INTO annotations (repo, path, body, session, created_at) VALUES (?, ?, ?, ?, ?)");
		const now = Date.now();
		return this.transaction(() => {
			for (const item of clean) insert.run(repo, item.path, this.encode(item.note), sessionId, now);
			return clean;
		});
	}

	/** The newest LEDGER_TAIL notes for one file, returned oldest first so they read as a ledger. */
	ledger(repo: string, file: string): LedgerFile {
		const total = Number(
			this.one<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM annotations WHERE repo = ? AND path = ?", repo, file)?.n ?? 0,
		);
		const rows = this.all<{ body: Uint8Array; session: string; created_at: number }>(
			"SELECT body, session, created_at FROM annotations WHERE repo = ? AND path = ? ORDER BY created_at DESC, id DESC LIMIT ?",
			repo,
			file,
			LEDGER_TAIL,
		);
		return {
			path: file,
			total,
			notes: rows.reverse().map((r) => ({ note: this.decode(r.body), session: r.session, at: Number(r.created_at) })),
		};
	}

	/** Embeds the query, scores every stored memory, decrypts the top-k. */
	async surface(query: string, signal?: AbortSignal): Promise<SurfaceResult> {
		// A read-only store's vectors are not ours to regenerate, so a model mismatch stops the search.
		if (this.readOnly) this.assertVectorsComparable();
		else await this.ensureEmbeddings(signal);
		const [qvec] = await embed([query], signal);
		const rows = this.all<MemoryRow>("SELECT id, body, emb, score, sessions FROM memories");

		const ranked: Array<{ row: MemoryRow; similarity: number; rank: number }> = [];
		let bestMiss = 0;
		for (const row of rows) {
			const vec = new Float32Array(row.emb.buffer, row.emb.byteOffset, row.emb.byteLength / 4);
			const similarity = cosine(qvec, vec);
			if (similarity < MIN_COSINE) {
				if (similarity > bestMiss) bestMiss = similarity;
				continue;
			}
			const influence = Math.max(-SCORE_INFLUENCE_CAP, Math.min(SCORE_INFLUENCE_CAP, row.score * SCORE_WEIGHT));
			ranked.push({ row, similarity, rank: similarity + influence });
		}
		ranked.sort((a, b) => b.rank - a.rank);
		const top = ranked.slice(0, TOP_K);

		const hits: SurfaceHit[] = top.map((t) => {
			const stamps = parseStamps(t.row.sessions);
			return {
				id: t.row.id,
				text: this.decode(t.row.body),
				score: Number(t.row.score.toFixed(2)),
				similarity: Number(t.similarity.toFixed(4)),
				rank: Number(t.rank.toFixed(4)),
				session: stamps[stamps.length - 1],
				stamps: stamps.length,
			};
		});

		return { hits, total: rows.length, bestMiss: Number(bestMiss.toFixed(4)) };
	}
}

/** A corrupt provenance chain costs one breadcrumb, not the whole surface call. */
function parseStamps(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
}

// ── Surface debug log ───────────────────────────────────────────────

/** Beside config.json, so the log stays put even when the memory store moves. */
const DEBUG_DB_PATH = path.join(DEFAULT_STORE_DIR, "surface-log.db");

/**
 * Off-by-default instrument for judging surface behavior: every `surface` query with the hits it
 * returned, and every rating against the surfaced ids. Read raw with sqlite3 — the corpus that
 * answers "is the model writing smart distills, and does the prompt give good direction?".
 *
 * Deliberately outside the memory store and always plaintext: it is a debug artifact, not data —
 * never migrated, never encrypted, deleted whenever the study is done.
 */
class SurfaceLog {
	private db: DatabaseSync;

	constructor() {
		fs.mkdirSync(DEFAULT_STORE_DIR, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(DEBUG_DB_PATH);
		this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS surface_queries (
				id        INTEGER PRIMARY KEY AUTOINCREMENT,
				ts        INTEGER NOT NULL,
				session   TEXT NOT NULL,
				query     TEXT NOT NULL,
				total     INTEGER NOT NULL,
				best_miss REAL NOT NULL
			);
			CREATE TABLE IF NOT EXISTS surface_hits (
				query_id    INTEGER NOT NULL REFERENCES surface_queries(id),
				position    INTEGER NOT NULL,
				hit_id      TEXT NOT NULL,
				similarity  REAL NOT NULL,
				helpfulness REAL NOT NULL,
				rank        REAL NOT NULL,
				text        TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS surface_votes (
				ts      INTEGER NOT NULL,
				session TEXT NOT NULL,
				hit_id  TEXT NOT NULL,
				helpful INTEGER NOT NULL
			);
		`);
	}

	/** One row per query, one per returned hit — `helpfulness` as it stood at surface time, so a later rating shows as a delta. */
	logSurface(session: string, query: string, merged: MergedSurface): void {
		const ts = Date.now();
		this.db.exec("BEGIN");
		try {
			const info = this.db
				.prepare("INSERT INTO surface_queries (ts, session, query, total, best_miss) VALUES (?, ?, ?, ?, ?)")
				.run(ts, session, query, merged.total, merged.bestMiss);
			const queryId = Number(info.lastInsertRowid);
			const hit = this.db.prepare(
				"INSERT INTO surface_hits (query_id, position, hit_id, similarity, helpfulness, rank, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			merged.hits.forEach((h, i) => hit.run(queryId, i + 1, h.id, h.similarity, h.score, h.rank, h.text));
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/** Ratings arrive in later calls than the query they answer; the join is on hit_id across tables. */
	logVotes(session: string, votes: Array<{ id: string; delta: number }>): void {
		const ts = Date.now();
		const stmt = this.db.prepare("INSERT INTO surface_votes (ts, session, hit_id, helpful) VALUES (?, ?, ?, ?)");
		this.db.exec("BEGIN");
		try {
			for (const v of votes) stmt.run(ts, session, v.id, v.delta > 0 ? 1 : 0);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// Same exits as the memory store's close.
		}
	}
}

// ── Ledger ───────────────────────────────────────────────────────────

interface LedgerFile {
	path: string;
	total: number;
	notes: Array<{ note: string; session: string; at: number }>;
}

/** Where ledger paths are relative to, and the key that keeps one repository's `src/index.ts` from another's. */
interface Repo {
	key: string;
	root: string;
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

/**
 * The root commit names a repository across clones, forks, and remote renames, where the remote URL
 * and the checkout path do not. A repository with no commits yet, or a directory outside git, falls
 * back to its path — notes there survive until it moves.
 */
function resolveRepo(cwd: string): Repo {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) return { key: `dir:${path.resolve(cwd)}`, root: path.resolve(cwd) };
	// A history with merged-in roots has several; sorted, the choice is stable.
	const first = git(root, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n").filter(Boolean).sort()[0];
	return { key: first ? `git:${first}` : `dir:${root}`, root };
}

/** The model names files relative to its working directory; the ledger keys them relative to the repository root. */
function ledgerPath(repo: Repo, cwd: string, file: string): string {
	const trimmed = file.trim();
	if (!trimmed) throw new Error("ledger paths must name a file; got an empty path.");
	const rel = path.relative(repo.root, path.resolve(cwd, trimmed));
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`"${file}" is outside the repository at ${repo.root}; the ledger only keys files inside it.`);
	}
	return rel.split(path.sep).join("/");
}

function renderLedger(files: LedgerFile[]): string {
	const lines: string[] = [];
	for (const file of files) {
		if (file.total === 0) {
			lines.push(`${file.path} — no notes`, "");
			continue;
		}
		lines.push(`${file.path} — ${file.total} note${file.total === 1 ? "" : "s"}`);
		const hidden = file.total - file.notes.length;
		if (hidden > 0) lines.push(`    (${hidden} earlier not shown)`);
		for (const n of file.notes) {
			lines.push(`    ${new Date(n.at).toISOString().slice(0, 10)}  ${n.session.slice(0, 8)}  ${n.note}`);
		}
		lines.push("");
	}
	lines.push("A note records how a past session touched the file. The file in front of you outranks it.");
	return lines.join("\n");
}

// ── Result formatting ────────────────────────────────────────────────

interface SurfaceResult {
	hits: SurfaceHit[];
	total: number;
	bestMiss: number;
}

/** What one configured store contributed: its results, or the reason it could not be searched. */
interface StoreSurface extends SurfaceResult {
	name: string;
	error?: string;
}

/** Every store's contribution, merged into one ranked list. */
interface MergedSurface {
	hits: SurfaceHit[];
	total: number;
	bestMiss: number;
	skipped: Array<{ name: string; error: string }>;
}

/**
 * Searches every configured store and merges the hits into one ranking. The local store is this
 * session's own, so when it fails the call fails: a soft "nothing matched" would hide a dead
 * credential. An optional store degrades to a note instead, so a broken shared corpus cannot take
 * the local results down with it.
 */
async function searchStores(stores: Stores, query: string, signal?: AbortSignal): Promise<MergedSurface> {
	const optional: Array<[string, MemoryStore]> = stores.global ? [["global", stores.global]] : [];
	const settled = await Promise.allSettled([
		stores.local.surface(query, signal),
		...optional.map(([, store]) => store.surface(query, signal)),
	]);
	const [local, ...rest] = settled;
	if (local.status === "rejected") throw local.reason;
	const perStore: StoreSurface[] = [
		{ name: "local", ...local.value },
		...rest.map((outcome, i): StoreSurface =>
			outcome.status === "fulfilled"
				? { name: optional[i][0], ...outcome.value }
				: { name: optional[i][0], hits: [], total: 0, bestMiss: 0, error: (outcome.reason as Error).message },
		),
	];
	// One ranking rule whatever the store count: `rank` already carries the helpfulness influence, so
	// merging on it preserves the order a single store would have produced.
	const merged = perStore
		.flatMap((s) => s.hits.map((hit) => ({ ...hit, store: s.name })))
		.sort((a, b) => b.rank - a.rank)
		.slice(0, TOP_K);
	// Naming the store tells the model where a memory came from, but with one store it is noise on
	// every line — so it is added only when there is more than one to tell apart.
	const contributors = new Set(perStore.filter((s) => s.hits.length > 0).map((s) => s.name));
	return {
		hits: merged.map(({ store, ...hit }) => (contributors.size > 1 ? { ...hit, text: `[${store}] ${hit.text}` } : hit)),
		total: perStore.reduce((n, s) => n + s.total, 0),
		bestMiss: perStore.reduce((best, s) => Math.max(best, s.bestMiss), 0),
		skipped: perStore.flatMap((s) => (s.error ? [{ name: s.name, error: s.error }] : [])),
	};
}

function renderSurface(result: MergedSurface): string {
	const lines: string[] = result.skipped.map((s) => `The ${s.name} store was skipped: ${s.error}`);
	if (lines.length) lines.push("");

	if (result.total === 0) {
		lines.push("The durable memory store is empty. Nothing has been carried forward yet.");
		lines.push("");
		lines.push("Work the task. When it is complete, call `action: \"checkpoint\"`, then send the facts a future");
		lines.push("session would need in one `action: \"mutate\"` call.");
		lines.push(checkpointReminder());
		return lines.join("\n");
	}

	if (result.hits.length === 0) {
		lines.push(
			`No stored memory matched this distill (searched ${result.total}, nothing cleared the ${MIN_COSINE} cosine floor; ` +
				`the closest scored ${result.bestMiss}).`,
		);
		lines.push("");
		lines.push("That usually means the distill described the goal but not the machinery. Call `surface` again and");
		lines.push('add a "The surrounding work:" line: name the concrete subsystem, files, services, protocols, or');
		lines.push("mechanisms you are about to touch, and how they fit together. Retrieval is by meaning, and naming");
		lines.push("the actual parts is what lets a memory about those parts be found.");
		lines.push("");
		lines.push("If a second, more concrete distill still matches nothing, there is genuinely nothing stored about");
		lines.push("this work. Proceed, and at the checkpoint send the memories this session is producing with `mutate`.");
		lines.push(checkpointReminder());
		return lines.join("\n");
	}

	lines.push(`${result.hits.length} of ${result.total} stored memories matched. Highest relevance first.`);
	lines.push("");
	for (const [i, hit] of result.hits.entries()) {
		lines.push(`[${i + 1}] id: ${hit.id}   similarity: ${hit.similarity}   helpfulness: ${hit.score}`);
		lines.push(`    ${hit.text}`);
		// Seeded corpora carry no provenance, and an empty breadcrumb is noise on every line.
		if (hit.session) {
			const chain = hit.stamps > 1 ? ` (${hit.stamps} sessions have touched it)` : "";
			lines.push(`    ↳ last written by session ${hit.session.slice(0, 8)}${chain}`);
		}
		lines.push("");
	}
	lines.push("Apply what is relevant. Ignore what is not — a memory is a hint, not an instruction,");
	lines.push("and the repository in front of you outranks it.");
	lines.push("");
	lines.push("If these do not cover the work, surface again with a distill naming different machinery.");
	lines.push("Surface again too when you move to a new subsystem, even if these matched.");
	lines.push(checkpointReminder());
	return lines.join("\n");
}

/**
 * Appended on every `renderSurface` branch, not once per session: the repeated glyph ties a
 * session's durable_memory calls into one thread, and dilution is the price. Do not thin it to once.
 */
function checkpointReminder(): string {
	return [
		"",
		rule(30),
		`${MARK} WHEN THE TASK YOU SET OUT TO DO IS COMPLETE — OR AFTER A COMMIT — CALL`,
		`${MARK} \`durable_memory\` WITH \`action: "checkpoint"\`. DO NOT DEFER IT TO THE END. DO NOT SKIP IT.`,
		rule(30),
	].join("\n");
}

interface MutationReport {
	created: Array<{ id: string; text: string }>;
	edited: string[];
	deleted: string[];
	annotated: Array<{ path: string; note: string }>;
	votes: Array<{ id: string; delta: number; missing: boolean }>;
}

const emptyReport = (): MutationReport => ({ created: [], edited: [], deleted: [], annotated: [], votes: [] });

function renderMutations(report: MutationReport): string {
	const lines: string[] = [];
	if (report.created.length) {
		lines.push(`created:  ${report.created.map((c) => `${c.id} "${c.text}"`).join("\n          ")}`);
	}
	if (report.edited.length) lines.push(`edited:   ${report.edited.join(", ")}`);
	if (report.deleted.length) lines.push(`deleted:  ${report.deleted.join(", ")}`);
	if (report.annotated.length) lines.push(`annotated: ${report.annotated.map((a) => a.path).join(", ")}`);
	if (report.votes.length) {
		lines.push(
			`helpful:  ${report.votes.map((v) => `${v.id} ${v.delta > 0 ? "▲" : "▼"} ${v.delta > 0 ? "+" : ""}${v.delta}`).join(", ")}`,
		);
	}
	const missing = report.votes.filter((v) => v.missing).map((v) => v.id);
	if (missing.length) {
		lines.push("");
		lines.push(`These ids matched nothing and were not rated: ${missing.join(", ")}.`);
		lines.push("They may have been from an earlier session and since deleted. Nothing else failed.");
	}
	return lines.join("\n");
}

// ── Tool ─────────────────────────────────────────────────────────────

const PARAMS = Type.Object({
	action: StringEnum(ACTIONS, {
		description:
			'"surface" retrieves memories matching a distill of the current work; it takes `query` and nothing ' +
			"else. \"checkpoint\" returns the recording instructions for the task you just completed; it takes " +
			"no argument. \"mutate\" applies the mutation arrays — every array you supply, in the order delete, " +
			"edit, create, annotate, helpful; delete first, so never delete and edit the same id in one call. " +
			'"ledger" takes `paths` and returns the per-file notes for each. An argument ' +
			"that does not belong to the named action is rejected — never silently ignored, never silently " +
			"applied. " +
			"Ids are the full ids `surface` returned; a prefix or unknown id is an error.",
	}),
	query: Type.Optional(
		Type.String({
			description:
				'Required for action "surface". A distill of the work you are about to do, in one to three sentences — as ' +
				"many as the work needs, no more. Name the task, the constraint you are working under, and what a good " +
				"outcome looks like, and name the concrete subsystem, files, services, or mechanisms you are about to " +
				'touch and how they fit together. A line starting "The surrounding work:" helps but is not required. ' +
				"Write it as a statement of the work, never as a question, and never as a request for memories. " +
				"Retrieval is by meaning, and naming the actual machinery is what lets a memory about that machinery be found.",
		}),
	),
	create: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Memory texts to store: one gnomic-present stative proposition per fact of what no readable " +
				"text supplies — endophorically complete (no deixis or exophora; the writing session is gone " +
				"at retrieval time), rigidly designated (paths, error strings, proper nouns, numerals — never " +
				"hypernyms), paratactically extended rather than subordinated, opening on the file, command, " +
				"or decision moment where it fires, and carrying its verification condition — the checkable " +
				"path, string, or command whose change proves the row stale. " +
				'Example: ["npm publish fails with 401/ENEEDAUTH — the ~/.npmrc token returns 401 on publish; ' +
				'the working credential is a bypass token only the user supplies on request."]',
		}),
	),
	edit: Type.Optional(
		Type.Array(Type.Object({ id: Type.String(), text: Type.String() }), {
			description:
				"Replace a stored memory's text; re-embeds it and appends this session to its provenance chain. " +
				"Where a surfaced id already carries the fact, `edit` it rather than `create` a variant.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Required for action "ledger". File paths relative to the working directory; returns the notes earlier ' +
				"sessions left on each file, oldest first.",
		}),
	),
	annotate: Type.Optional(
		Type.Array(Type.Object({ path: Type.String(), note: Type.String() }), {
			description:
				"One entry per file edited or written: the path relative to the working directory, and one short " +
				`sentence (at most ${NOTE_MAX} characters) on how this work touched it. Appended to that file's ` +
				"ledger, never embedded, never surfaced by similarity.",
		}),
	),
	delete: Type.Optional(Type.Array(Type.String(), { description: "Full ids of memories to remove permanently." })),
	helpful: Type.Optional(
		Type.Array(Type.Object({ id: Type.String(), helpful: Type.Boolean() }), {
			description:
				"Rate every id `surface` showed you this session, including the merely irrelevant: true raises a " +
				"memory's future ranking, false lowers it.",
		}),
	),
});

const DESCRIPTION = [
	"Long-term memory that persists across sessions, searched by embedding similarity and optionally encrypted at rest.",
	"",
	"`action` selects what a call does — required, and every argument must belong to it:",
	'	"surface" takes `query` — a distill of the work, shaped as the parameter description specifies — and returns',
	"	what no readable text supplies.",
	'	"checkpoint" takes nothing and returns the recording instructions for one completed task — not for the session.',
	'	"mutate" takes the mutation arrays (delete, edit, create, annotate, helpful) and applies them in that order.',
	'	"ledger" takes `paths` relative to the working directory and returns the one-line notes earlier sessions',
	"	left on each file.",
].join("\n");

interface ToolDetails {
	action: string;
	hits?: SurfaceHit[];
	ledger?: LedgerFile[];
	report: MutationReport;
}

const toolResult = (action: string, report: MutationReport, text: string, extra?: Partial<ToolDetails>): AgentToolResult<ToolDetails> => ({
	content: [{ type: "text", text }],
	details: { action, report, ...extra },
});

// ── Extension ────────────────────────────────────────────────────────

export default function durableMemoryExtension(pi: ExtensionAPI) {
	let store: Stores | undefined;
	let surfaceCalls = 0;
	let debugLog: SurfaceLog | undefined;

	const log = (): SurfaceLog | undefined => {
		if (!resolveSettings().debug) return undefined;
		debugLog ??= new SurfaceLog();
		return debugLog;
	};

	const openStores = (): Stores => {
		if (store) return store;
		const r = resolveSettings();
		store = {
			local: new MemoryStore(r.storeDir),
			// Seeded out of band and shared, so it is opened read-only: searched, never written.
			global: r.globalStoreDir ? new MemoryStore(r.globalStoreDir, { readOnly: true }) : undefined,
		};
		return store;
	};

	const openStore = (): MemoryStore => openStores().local;

	/** Two git calls per working directory per session, not per note. */
	const repos = new Map<string, Repo>();
	const repoFor = (cwd: string): Repo => {
		let repo = repos.get(cwd);
		if (!repo) {
			repo = resolveRepo(cwd);
			repos.set(cwd, repo);
		}
		return repo;
	};

	/**
	 * Applies every mutation array present, in a fixed order, to the local store — the global one is
	 * not writable. Called only from the `mutate` branch: `action` dispatches strictly, so an array can
	 * only ever be applied by a call that named `mutate`. The order is delete, edit, create, annotate,
	 * helpful so a call can never half-apply a delete-and-edit of the same id.
	 */
	async function applyMutations(
		params: {
			delete?: string[];
			edit?: Array<{ id: string; text: string }>;
			create?: string[];
			annotate?: Array<{ path: string; note: string }>;
			helpful?: Array<{ id: string; helpful: boolean }>;
		},
		sessionId: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<MutationReport> {
		const hasAny =
			params.delete?.length ||
			params.edit?.length ||
			params.create?.length ||
			params.annotate?.length ||
			params.helpful?.length;
		if (!hasAny) return emptyReport();

		const db = openStore();
		const report = emptyReport();
		if (params.delete?.length) report.deleted = db.delete(params.delete);
		if (params.edit?.length) report.edited = await db.edit(params.edit, sessionId, signal);
		if (params.create?.length) report.created = await db.create(params.create, sessionId, signal);
		if (params.annotate?.length) {
			const repo = repoFor(cwd);
			const items = params.annotate.map((a) => ({ path: ledgerPath(repo, cwd, a.path), note: a.note }));
			report.annotated = db.annotate(repo.key, items, sessionId);
		}
		if (params.helpful?.length) report.votes = db.vote(params.helpful);
		return report;
	}

	const tool: ToolDefinition<typeof PARAMS, ToolDetails> = {
		name: "durable_memory",
		label: "Durable Memory",
		description: DESCRIPTION,
		promptSnippet: "Cross-session memory; surface early and often, close out each task",
		promptGuidelines: [
			"If you have not yet called `durable_memory` with `action: \"surface\"` in this conversation, call it before your " +
				"first edit, write, or command that changes state. Reading files first and speaking with the user is fine " +
				"and expected — surface before you act, not before you look. Check your own transcript for a previous " +
				"`durable_memory` call rather than judging whether you feel oriented.",
			"Surface is not a one-time check — it is a habit across the session. Call `durable_memory` with " +
				'`action: "surface"` again whenever the work pivots to a different subsystem, file, or mechanism than the ' +
				"one you last surfaced for, and whenever a new task begins.",
			"When you complete a task or commit, call `durable_memory` with `action: \"checkpoint\"` before reporting " +
				"the result — even if the session continues. Check your transcript for a `checkpoint` call after that " +
				"task or commit rather than waiting for the session to end, which is not something you can observe.",
		],
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		parameters: PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("durable_memory call was aborted.");
			const sessionId = ctx.sessionManager.getSessionId();
			// The schema marks `action` required, but the harness does not enforce required fields before
			// execute runs — so this gate is what actually holds. A call with no action names nothing.
			const action = params.action as Action | undefined;
			if (!action) {
				throw new Error("durable_memory requires `action` — one of surface, checkpoint, mutate, ledger. " +
					"Arguments select nothing on their own.");
			}

			// Strict dispatch: an argument that does not belong to the named action is rejected, never ignored
			// and never applied. This is the boundary that keeps a reply-only call (checkpoint) from
			// silently carrying writes, and keeps a search (surface) from silently carrying ratings.
			const mutationCount =
				(params.delete?.length ?? 0) + (params.edit?.length ?? 0) + (params.create?.length ?? 0) +
				(params.annotate?.length ?? 0) + (params.helpful?.length ?? 0);
			if (action !== "ledger" && params.paths !== undefined) {
				throw new Error(`action "${action}" does not take \`paths\` — a file's notes are read with action "ledger".`);
			}
			if (action === "ledger" && (mutationCount > 0 || params.query)) {
				throw new Error('action "ledger" takes only `paths`. Notes are written with `annotate` under action ' +
					'"mutate"; a distill goes with action "surface".');
			}
			if (action === "surface" && mutationCount > 0) {
				throw new Error('action "surface" takes only `query` — mutation arrays are rejected here. ' +
					'Resend them with action "mutate".');
			}
			if (action === "checkpoint" && (mutationCount > 0 || params.query)) {
				throw new Error('action "checkpoint" takes no argument. Mutations are sent with action "mutate"; ' +
					'a distill with action "surface".');
			}

			if (action === "checkpoint") {
				return toolResult("checkpoint", emptyReport(), CHECKPOINT_MESSAGE);
			}

			if (action === "surface") {
				const query = params.query?.trim();
				if (!query) throw new Error('action "surface" requires `query`: a distill of the work (one to three sentences).');
				const merged = await searchStores(openStores(), query, signal);
				surfaceCalls++;
				log()?.logSurface(sessionId, query, merged);
				return toolResult("surface", emptyReport(), renderSurface(merged), { hits: merged.hits });
			}

			if (action === "ledger") {
				const wanted = (params.paths ?? []).filter((p) => p.trim());
				if (!wanted.length) throw new Error('action "ledger" requires `paths`: file paths relative to the working directory.');
				const repo = repoFor(ctx.cwd);
				const db = openStore();
				const files = wanted.map((p) => db.ledger(repo.key, ledgerPath(repo, ctx.cwd, p)));
				return toolResult("ledger", emptyReport(), renderLedger(files), { ledger: files });
			}

			if (mutationCount === 0) {
				throw new Error('action "mutate" applied nothing — supply at least one well-formed mutation array ' +
					"(delete, edit, create, annotate, helpful).");
			}
			const report = await applyMutations(params, sessionId, ctx.cwd, signal);
			// The pre-gate counts arrays; this one counts effects — a create of only whitespace has
			// nothing to show for its arrays, and a silent empty report is worse than an error.
			if (!Object.values(report).some((a) => a.length > 0)) {
				throw new Error('action "mutate" applied nothing — supply at least one well-formed mutation array ' +
					"(delete, edit, create, annotate, helpful).");
			}
			const dbg = log();
			if (dbg && report.votes.length) dbg.logVotes(sessionId, report.votes);
			return toolResult("mutate", report, renderMutations(report));
		},
	};

	pi.registerTool(tool);

	const statusText = (ctx: ExtensionContext): string => {
		try {
			const r = resolveSettings();
			const { local, global } = openStores();
			const lines = [
				`memories:  ${local.count()}${global ? ` local + ${global.count()} global` : ""}`,
				`ledger:    ${local.annotationCount()} file note${local.annotationCount() === 1 ? "" : "s"}`,
				`store:     ${local.dir}`,
			];
			if (global) lines.push(`global:    ${global.dir} (read-only)`);
			lines.push(
				`settings:  ${CONFIG_PATH}`,
				`endpoint:  ${r.endpoint} · ${r.model} @ ${r.url}${r.urlOverridden ? " (overridden)" : ""}`,
				`auth key:  ${r.keySource}`,
				`vectors:   ${local.embedder() ?? "none written yet"}`,
				`encrypted: ${local.encrypted ? "yes" : "no"} (local store)`,
				`debug:     ${r.debug ? `on — logging surface queries to ${DEBUG_DB_PATH}` : "off"}`,
				`session:   ${ctx.sessionManager.getSessionId()}`,
				`this session: ${surfaceCalls} surface call${surfaceCalls === 1 ? "" : "s"}`,
			);
			return lines.join("\n");
		} catch (err) {
			return `durable memory unavailable: ${(err as Error).message}`;
		}
	};

	/** Each edit writes immediately; the redrawn rows are the confirmation. */
	const runSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
		for (;;) {
			const s = readSettings();
			const r = resolveSettings();
			const rows: Array<[Key | "status" | "done" | "encrypt", string]> = [
				["endpoint", `Endpoint        ${r.endpoint}`],
				["url", `URL             ${r.url}${r.urlOverridden ? " (overridden)" : ""}`],
				["model", `Embedding model ${r.model}`],
				["apiKey", `Auth key        ${r.apiKey ? `set (…${r.apiKey.slice(-4)})` : "not set"}`],
				["storeDir", `Database dir    ${r.storeDir}`],
				["encrypt", `Encryption      ${openStore().encrypted ? "encrypted" : "unencrypted"} (local)`],
				["debug", `Debug logging   ${r.debug ? "on" : "off"}`],
				["status", "Show status"],
				["done", "Done"],
			];
			const picked = await ctx.ui.select("Durable memory", rows.map(([, label]) => label));
			const key = rows.find(([, label]) => label === picked)?.[0];
			if (!key || key === "done") return;
			if (key === "encrypt") {
				const db = openStore();
				try {
					db.switchEncryption(!db.encrypted); // generates the keyfile on the first switch to encrypted
					ctx.ui.notify(`Local store is now ${db.encrypted ? "encrypted" : "unencrypted"}.`, "info");
				} catch (err) {
					ctx.ui.notify((err as Error).message, "error");
				}
				continue;
			}

			if (key === "debug") {
				writeSettings({ ...s, debug: !r.debug });
				ctx.ui.notify(`Debug logging is now ${!r.debug ? "on" : "off"}.`, "info");
				continue;
			}

			if (key === "status") {
				ctx.ui.notify(statusText(ctx), "info");
				continue;
			}

			if (key === "endpoint") {
				// A picker, nothing more: the URL is the chosen endpoint's preset unless the URL row overrides it.
				const picked = await ctx.ui.select("Embeddings run on", [...ENDPOINTS]);
				if (!picked) continue;
				const { url: _previousUrl, ...rest } = s;
				writeSettings({ ...rest, endpoint: picked as Endpoint });
				ctx.ui.notify(`Embeddings endpoint is now ${picked}.`, "info");
				continue;
			}

			if (key === "url") {
				const typed = await ctx.ui.input(`Embeddings URL (blank restores the ${r.endpoint} preset)`, r.url);
				if (typed === undefined) continue;
				// Blank clears the override, so the endpoint's preset takes over again.
				writeSettings({ ...s, url: typed.trim() || undefined });
				continue;
			}

			if (key === "storeDir") {
				const typed = await ctx.ui.input("Database directory (blank restores the default)", r.storeDir);
				if (typed === undefined) continue;
				const dir = typed.trim() ? path.resolve(typed.trim()) : DEFAULT_STORE_DIR;
				try {
					assertStoreDir(dir);
				} catch (err) {
					ctx.ui.notify((err as Error).message, "error");
					continue;
				}
				writeSettings({ ...s, storeDir: dir });
				ctx.ui.notify("Reopen pi to use the new store location.", "info");
				continue;
			}

			// model and apiKey are both a string that blanks back to the default.
			const label = key === "apiKey" ? "Auth key for the endpoint (blank clears it)" : "Embedding model";
			const typed = await ctx.ui.input(label, String(s[key] ?? ""));
			if (typed !== undefined) writeSettings({ ...s, [key]: typed.trim() || undefined });
		}
	};

	pi.registerCommand("durable-memory", {
		description: "Durable memory: configure endpoint, auth key, and database directory: /durable-memory",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() !== "status" && ctx.hasUI) {
				await runSettings(ctx);
				return;
			}
			// Without a dialog-capable UI (`pi --print`, `pi --json`) there is no menu to run, and
			// `ui.notify` is a no-op there. stdout belongs to the run's own output, so status goes to stderr.
			const text = statusText(ctx);
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else process.stderr.write(`${text}\n`);
		},
	});

	// Stores are per-session, not per-process: dropping them here is what makes the embedding check
	// run once per session, and it lets a session pick up settings edited since the last one started.
	const closeStores = (): void => {
		store?.local.close();
		store?.global?.close();
		store = undefined;
		debugLog?.close();
		debugLog = undefined;
	};

	/**
	 * Announces every version's notes on the first two interactive session starts after that version
	 * installs, then never again for that version. Each version carries its own count in the marker
	 * file, so a user who skipped an intermediate release still gets its note, and a user who already
	 * saw one never sees it again when a newer note arrives. The marker advances only when a note was
	 * actually shown — headless runs (notify is a no-op there) leave it unwritten, and the next
	 * interactive session still sees the note.
	 */
	const announceReleaseNotes = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const counts = new Map(
			(fs.existsSync(ANNOUNCED_PATH) ? fs.readFileSync(ANNOUNCED_PATH, "utf8") : "")
				.split("\n")
				.map((line) => line.trim().split(" "))
				.filter((parts) => parts.length === 2 && parts[0] && Number.isFinite(Number(parts[1])))
				.map((parts) => [parts[0], Number(parts[1])]),
		);
		for (const [version, note] of Object.entries(RELEASE_NOTES).sort(([a], [b]) => compareVersions(a, b))) {
			const shown = counts.get(version) ?? 0;
			if (shown >= ANNOUNCES_PER_VERSION) continue;
			counts.set(version, shown + 1);
			fs.mkdirSync(DEFAULT_STORE_DIR, { recursive: true, mode: 0o700 });
			fs.writeFileSync(
				ANNOUNCED_PATH,
				[...counts.entries()].sort(([a], [b]) => compareVersions(a, b)).map(([v, n]) => `${v} ${n}`).join("\n") + "\n",
				{ mode: 0o600 },
			);
			ctx.ui.notify(`pi-durable-memory ${version}\n${note}`, "info");
		}
	};

	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		announceReleaseNotes(ctx);
		surfaceCalls = 0;
		repos.clear();
		closeStores();
	});

	pi.on("session_shutdown", closeStores);
}

export { DEFAULT_STORE_DIR, CONFIG_PATH, resolveSettings, readSettings };
