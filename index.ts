/**
 * Durable Memory — encrypted, embedding-searched long-term memory across pi sessions.
 *
 * The model opens a session with `op: "surface"` (a three-sentence distill of the work),
 * gets back the top-k stored memories ranked by cosine similarity plus a helpfulness score,
 * and closes the session with `op: "finish"`, which returns a fixed push alert telling it to
 * create new memories and rate the ones it was shown — batched into a single call.
 *
 * Memory bodies are AES-256-GCM encrypted at rest. Their embeddings are not: encrypted
 * content cannot be searched, so the cleartext embedding sits beside the ciphertext and the
 * plaintext is recoverable by anyone who can invert the vector. Only the top-k matched rows
 * are ever decrypted, so a large store of low-score silt costs nothing at query time.
 *
 * Every write stamps the active pi session id as a provenance breadcrumb — automatic, never
 * model-supplied. `edit` appends; the newest stamp is the operative one.
 *
 * This directory is the package. The database and the key live beside this file so the whole
 * thing is self-contained and installable; both are excluded from publication.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ── Paths and settings ───────────────────────────────────────────────

/** `PI_CODING_AGENT_DIR` is pi's documented override for the config directory. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

/**
 * The store never lives inside the package.
 *
 * `pi update --extensions` replaces an npm package directory wholesale — a version bump
 * re-extracts the tarball over it — so a store kept beside this file is deleted on the first
 * update. Verified by upgrading a scratch install: memory.db and memory.key both vanished. The
 * default therefore sits in pi's config directory, outside every directory pi reconciles, and
 * survives updates and reinstalls.
 */
const DEFAULT_STORE_DIR = path.join(AGENT_DIR, "durable-memory");

/** Fixed home for settings. It must not move when the store directory moves. */
const CONFIG_PATH = path.join(DEFAULT_STORE_DIR, "config.json");

const AUTH_PATH = path.join(AGENT_DIR, "auth.json");

const DEFAULT_EMBED_MODEL = "emb-qwen3";
const REMOTE_EMBED_URL = "https://gw.lunaroute.com/v1/embeddings";
const LOCAL_EMBED_URL = "http://localhost:8080/v1/embeddings";
const DEFAULT_EMBED_PROVIDER = "lunaroute";

interface DurableConfig {
	/** "remote" sends embeddings to a hosted OpenAI-compatible endpoint; "local" to a llama.cpp,
	 *  Ollama or LM Studio server on this machine. */
	endpoint?: "remote" | "local";
	/** Overrides the URL implied by `endpoint`. */
	url?: string;
	model?: string;
	/** Bearer token for the endpoint. Stored mode 0600, alongside this file's other secrets. */
	apiKey?: string;
	/** Where memory.db and memory.key live. */
	storeDir?: string;
}

function loadConfig(): DurableConfig {
	if (!fs.existsSync(CONFIG_PATH)) return {};
	const raw = fs.readFileSync(CONFIG_PATH, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${CONFIG_PATH} is not valid JSON. Fix it or delete it to start from defaults.`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${CONFIG_PATH} must contain a JSON object.`);
	}
	return parsed as DurableConfig;
}

function saveConfig(config: DurableConfig): void {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(CONFIG_PATH, 0o600);
}

/**
 * Env vars win over the settings file, then the field defaults. Env remains the escape hatch for
 * CI and one-off runs; the file is what the settings command writes.
 */
function storeDirOf(config: DurableConfig): string {
	const dir = process.env.DURABLE_MEMORY_DIR ?? config.storeDir ?? DEFAULT_STORE_DIR;
	// A store inside node_modules is a store a package manager will delete. Refuse rather than
	// let a stored setting reintroduce the hazard the default exists to remove.
	if (dir.split(path.sep).includes("node_modules")) {
		throw new Error(
			`The store directory points inside node_modules (${dir}). A package update would delete the store. ` +
				`Choose a stable directory outside any installed package, such as ${DEFAULT_STORE_DIR}.`,
		);
	}
	return dir;
}

export interface StorePaths {
	dir: string;
	db: string;
	key: string;
}

function storePathsOf(config: DurableConfig): StorePaths {
	const dir = storeDirOf(config);
	return { dir, db: path.join(dir, "memory.db"), key: path.join(dir, "memory.key") };
}

// ── Tuning ───────────────────────────────────────────────────────────

/** Attention-sink marker. Rare enough that it does not occur in ordinary prose. */
const MARK = "⟁";

/**
 * Cosine floor and result cap, measured on `emb-qwen3` over the 35-memory benchmark in
 * `bench/` (harvested from real past sessions; queries written with no content words in
 * common with their target, so the numbers are semantic, not lexical).
 *
 * 0.44 is the maximum-margin floor: off-topic queries peaked at 0.408 and the weakest
 * on-topic true match sat at 0.477, so it clears both by ~0.035. Recall is flat in floor
 * from 0.30 to 0.49 — the floor only rejects off-topic work, it does not tune precision.
 * K=8 is the knee: recall plateaus there (35/35) and only decays in precision beyond it.
 * The floor does the real filtering; a typical query passes ~4.5 memories of 8 slots.
 *
 * Re-run `bench/sweep.mjs` after changing the embedding model — these are model-specific.
 */
const MIN_COSINE = 0.44;
const TOP_K = 8;

/**
 * DECLINED-ALTERNATIVE: hubness correction (subtract each memory's mean similarity to all
 * others, which suppresses the few memories that match everything). Measured on the same
 * benchmark: +0.11 MRR on terse queries, but only +0.003 once the distill names the
 * surrounding work — and it costs an O(n^2 * dim) pass per query. Not worth it. Revisit if
 * the store grows past a few thousand rows and specific memories start dominating results.
 */

/** helpful/unhelpful moves the score by this much. */
const VOTE_STEP = 0.5;
/** Score's influence on ranking, and the cap that keeps a much-voted memory from ranking on similarity it does not have. */
const SCORE_WEIGHT = 0.05;
const SCORE_INFLUENCE_CAP = 0.25;

const OPS = ["surface", "finish", "create", "pointer", "edit", "delete", "helpful"] as const;
type Op = (typeof OPS)[number];

/**
 * Returned verbatim on every `finish` call — same bytes every time, in every session, however
 * many times it fires. The wording is deliberately task-scoped rather than session-scoped:
 * a model cannot observe "the session is ending", but it can observe "the task I set out to do
 * is done", so that is the trigger. Wording must stay correct on the second and third call.
 */
const FINISH_MESSAGE = [
	`${rule()} TASK CLOSEOUT — DO THIS NOW ${rule()}`,
	"",
	"You just completed a task. Batch the following into ONE `durable_memory` call:",
	"",
	"1. `create` — every fact worth carrying into a future session that you learned while doing it:",
	"   a user preference, a project convention, a constraint that cost you time to discover, a fix",
	"   that worked. One self-contained sentence each, readable with no other context. Do not store",
	"   what is already obvious from the repository, and do not store this session's narration.",
	"",
	"2. `helpful` — rate every id you were shown by `surface` and have not already rated. `true` if it",
	"   changed what you did or saved you work; `false` if it was irrelevant or misleading. Ratings",
	"   decide what surfaces next time, so an unrated memory is a wasted one. Guess rather than skip.",
	"",
	"3. `edit` / `delete` / `pointer` — correct a memory that was wrong, remove one that is dead,",
	"   or attach a note to one that needs a caveat.",
	"",
	"This is not the end of the session. If you take on another task, call `finish` again when that",
	"one is complete.",
	"",
	"Submit all of it in ONE call whose `op` is `create` — not another `finish`, and not one call",
	"per item. If nothing you learned is worth carrying forward, send only the ratings and leave",
	"`create` out entirely: a memory recording that a task was routine is itself silt, and an empty",
	"closeout is the correct answer to a routine task.",
	"",
	"Example single call:",
	'   { "op": "create", "create": ["..."], "helpful": [{"id":"a1b2c3d4","helpful":true},{"id":"e5f6a7b8","helpful":false}] }',
].join("\n");

function rule(width = 5): string {
	return MARK.repeat(width);
}

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

/** Creates the store directory if absent (mode 0700) and the keyfile on first use (mode 0600). */
/** Creates the store directory if absent (mode 0700) and the keyfile on first use (mode 0600). */
function loadKey(keyPath: string): Buffer {
	fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
	if (fs.existsSync(keyPath)) {
		const raw = fs.readFileSync(keyPath);
		if (raw.length !== 32) throw new Error(`${keyPath} is ${raw.length} bytes, expected 32. Delete it to regenerate.`);
		return raw;
	}
	const key = crypto.randomBytes(32);
	fs.writeFileSync(keyPath, key, { mode: 0o600 });
	fs.chmodSync(keyPath, 0o600);
	return key;
}

// ── Embeddings ───────────────────────────────────────────────────────

interface EmbedConfig {
	url: string;
	model: string;
	key: string;
	keySource: string;
}

/**
 * Credential and endpoint lookup. Precedence, first hit wins:
 *
 *   url/model:  env  >  settings file  >  endpoint implied by settings  >  defaults
 *   key:        env DURABLE_MEMORY_EMBED_KEY  >  settings file apiKey  >  auth.json[provider]
 *
 * The shell-level LUNAROUTE_API_KEY is deliberately not consulted: pi's lunaroute provider
 * authenticates with OAuth, and a stale shell key would be picked up ahead of the working one.
 */
function resolveEmbedConfig(config: DurableConfig): EmbedConfig {
	const endpoint = config.endpoint ?? "remote";
	const url =
		process.env.DURABLE_MEMORY_EMBED_URL ?? config.url ?? (endpoint === "local" ? LOCAL_EMBED_URL : REMOTE_EMBED_URL);
	const model = process.env.DURABLE_MEMORY_EMBED_MODEL ?? config.model ?? DEFAULT_EMBED_MODEL;
	const provider = process.env.DURABLE_MEMORY_EMBED_PROVIDER ?? DEFAULT_EMBED_PROVIDER;

	const fromEnv = process.env.DURABLE_MEMORY_EMBED_KEY;
	if (fromEnv) return { url, model, key: fromEnv, keySource: "DURABLE_MEMORY_EMBED_KEY" };
	if (config.apiKey) return { url, model, key: config.apiKey, keySource: CONFIG_PATH };

	// A local endpoint often needs no credential at all; only fall through to auth.json when it
	// holds the provider entry, so a local server does not fail demanding a cloud token.
	let entry: Record<string, unknown> | undefined;
	try {
		entry = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))[provider];
	} catch {
		entry = undefined;
	}
	const key = (entry?.key ?? entry?.access) as string | undefined;
	if (key) return { url, model, key, keySource: `auth.json:${provider}` };

	if (endpoint === "local") return { url, model, key: "", keySource: "none (local endpoint)" };

	throw new Error(
		`No embedding credential. Run /durable-memory to set an auth key, or set DURABLE_MEMORY_EMBED_KEY, ` +
			`or add a \`${provider}\` entry to ${AUTH_PATH} (run pi once against that provider to complete its auth flow).`,
	);
}

/** OpenAI-compatible /embeddings. Throws on any non-2xx or malformed response — no silent zeros. */
async function embed(texts: string[]): Promise<Float32Array[]> {
	if (texts.length === 0) return [];
	// Read settings per call so a change made by the settings command takes effect immediately.
	const cfg = resolveEmbedConfig(loadConfig());

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
	const res = await fetch(cfg.url, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: cfg.model, input: texts }),
		signal: AbortSignal.timeout(30_000),
	});
	const body = await res.text();
	if (!res.ok) {
		throw new Error(`Embedding request failed: HTTP ${res.status} from ${cfg.url} — ${body.slice(0, 300)}`);
	}

	let parsed: { data?: Array<{ index: number; embedding: number[] }>; error?: { message?: string } };
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error(`Embedding response was not JSON: ${body.slice(0, 200)}`);
	}
	const data = parsed.data;
	if (!Array.isArray(data) || data.length !== texts.length) {
		throw new Error(`Embedding response returned ${data?.length ?? 0} vectors for ${texts.length} inputs.`);
	}

	// Order by the returned index, never by array position: the provider may reorder.
	const byIndex = new Map<number, number[]>();
	for (const item of data) {
		if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
			throw new Error(`Embedding at index ${item.index} was empty.`);
		}
		byIndex.set(item.index, item.embedding);
	}
	if (byIndex.size !== texts.length) {
		throw new Error(`Embedding response had duplicate or missing indexes: got ${[...byIndex.keys()].join(",")}`);
	}
	return texts.map((_, i) => {
		const vec = byIndex.get(i)!;
		const out = new Float32Array(vec.length);
		for (let j = 0; j < vec.length; j++) out[j] = vec[j];
		return out;
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

/** node:sqlite types every column as a union, so each read crosses one cast here and nowhere else. */
function asRows<T>(rows: unknown): T[] {
	return rows as T[];
}
function asRow<T>(row: unknown): T | undefined {
	return row as T | undefined;
}
function toBlob(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

interface MemoryRow {
	id: string;
	body: Uint8Array;
	emb: Uint8Array;
	dim: number;
	score: number;
	sessions: string;
}

interface SurfaceHit {
	id: string;
	text: string;
	score: number;
	rank: number;
	similarity: number;
	pointers: string[];
	/** Newest stamp in the provenance chain — the session that last wrote this memory. */
	session: string;
	/** How many sessions have touched it. */
	stamps: number;
}

export class MemoryStore {
	private db: DatabaseSync;
	private key: Buffer;
	readonly paths: StorePaths;

	constructor(paths: StorePaths) {
		this.paths = paths;
		this.key = loadKey(paths.key);
		this.db = new DatabaseSync(paths.db);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS memories (
				id         TEXT PRIMARY KEY,
				body       BLOB NOT NULL,
				emb        BLOB NOT NULL,
				dim        INTEGER NOT NULL,
				score      REAL NOT NULL DEFAULT 0,
				surfaces   INTEGER NOT NULL DEFAULT 0,
				sessions   TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pointers (
				id         TEXT PRIMARY KEY,
				memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
				body       BLOB NOT NULL,
				session_id TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pointers_memory ON pointers(memory_id);
			CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
		`);
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// Already closed: reload, session replacement, and process exit converge here.
		}
	}

	private newId(table: "memories" | "pointers"): string {
		for (let attempt = 0; attempt < 20; attempt++) {
			const id = crypto.randomBytes(4).toString("hex");
			if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
		}
		throw new Error(`Could not allocate a free ${table} id after 20 attempts.`);
	}

	/** The embedder whose vectors live in this DB. A changed model means incomparable vectors. */
	embedder(): string | undefined {
		return asRow<{ v: string }>(this.db.prepare("SELECT v FROM meta WHERE k = 'embedder'").get())?.v;
	}

	setEmbedder(value: string): void {
		this.db.prepare("INSERT INTO meta (k, v) VALUES ('embedder', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(value);
	}

	count(): number {
		return Number(asRow<{ n: number | bigint }>(this.db.prepare("SELECT COUNT(*) AS n FROM memories").get())?.n ?? 0);
	}

	async create(texts: string[], sessionId: string): Promise<Array<{ id: string; text: string }>> {
		const clean = texts.map((t) => t.trim()).filter((t) => t.length > 0);
		if (clean.length === 0) return [];
		const vectors = await embed(clean);
		const now = Date.now();
		const insert = this.db.prepare(
			"INSERT INTO memories (id, body, emb, dim, score, sessions, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
		);
		const created: Array<{ id: string; text: string }> = [];
		for (let i = 0; i < clean.length; i++) {
			const id = this.newId("memories");
			insert.run(id, encrypt(this.key, clean[i]), toBlob(vectors[i]), vectors[i].length, JSON.stringify([sessionId]), now, now);
			created.push({ id, text: clean[i] });
		}
		this.setEmbedder(resolveEmbedConfig(loadConfig()).model);
		return created;
	}

	async edit(items: Array<{ id: string; text: string }>, sessionId: string): Promise<string[]> {
		const applied: string[] = [];
		for (const item of items) {
			const row = this.findById(item.id);
			if (!row) throw new Error(`edit: no memory with id "${item.id}".`);
			const text = item.text.trim();
			if (!text) throw new Error(`edit: replacement text for "${item.id}" was empty.`);
			const [vec] = await embed([text]);
			const stamps = appendStamp(parseStamps(row.sessions), sessionId);
			this.db
				.prepare("UPDATE memories SET body = ?, emb = ?, dim = ?, sessions = ?, updated_at = ? WHERE id = ?")
				.run(encrypt(this.key, text), toBlob(vec), vec.length, JSON.stringify(stamps), Date.now(), row.id);
			applied.push(row.id);
		}
		return applied;
	}

	delete(ids: string[]): string[] {
		const stmt = this.db.prepare("DELETE FROM memories WHERE id = ?");
		const removed: string[] = [];
		for (const id of ids) {
			const row = this.findById(id);
			if (!row) continue;
			stmt.run(row.id);
			removed.push(row.id);
		}
		return removed;
	}

	async addPointers(items: Array<{ id: string; note: string }>, sessionId: string): Promise<string[]> {
		const added: string[] = [];
		for (const item of items) {
			const row = this.findById(item.id);
			if (!row) throw new Error(`pointer: no memory with id "${item.id}".`);
			const note = item.note.trim();
			if (!note) throw new Error(`pointer: note for "${item.id}" was empty.`);
			const id = this.newId("pointers");
			this.db
				.prepare("INSERT INTO pointers (id, memory_id, body, session_id, created_at) VALUES (?, ?, ?, ?, ?)")
				.run(id, row.id, encrypt(this.key, note), sessionId, Date.now());
			added.push(id);
		}
		return added;
	}

	/** true moves a memory up future rankings, false sinks it toward silt. */
	vote(items: Array<{ id: string; helpful: boolean }>): Array<{ id: string; delta: number; missing: boolean }> {
		const out: Array<{ id: string; delta: number; missing: boolean }> = [];
		for (const item of items) {
			const row = this.findById(item.id);
			const delta = item.helpful ? VOTE_STEP : -VOTE_STEP;
			if (!row) {
				out.push({ id: item.id, delta, missing: true });
				continue;
			}
			this.db.prepare("UPDATE memories SET score = score + ?, updated_at = ? WHERE id = ?").run(delta, Date.now(), row.id);
			out.push({ id: row.id, delta, missing: false });
		}
		return out;
	}

	/** Accepts a full short id or an unambiguous prefix of one. */
	findId(shortOrPrefix: string): string | undefined {
		const needle = shortOrPrefix.trim().toLowerCase();
		if (!needle) return undefined;
		const exact = asRow<{ id: string }>(this.db.prepare("SELECT id FROM memories WHERE id = ?").get(needle));
		if (exact) return exact.id;
		const prefixed = asRows<{ id: string }>(
			this.db.prepare("SELECT id FROM memories WHERE id LIKE ? LIMIT 2").all(`${needle}%`),
		);
		return prefixed.length === 1 ? prefixed[0].id : undefined;
	}

	private findById(shortOrPrefix: string): MemoryRow | undefined {
		const id = this.findId(shortOrPrefix);
		if (!id) return undefined;
		return asRow<MemoryRow>(
			this.db.prepare("SELECT id, body, emb, dim, score, sessions FROM memories WHERE id = ?").get(id),
		);
	}

	private pointersFor(memoryIds: string[]): Map<string, string[]> {
		const out = new Map<string, string[]>();
		if (memoryIds.length === 0) return out;
		const placeholders = memoryIds.map(() => "?").join(",");
		const rows = asRows<{ memory_id: string; body: Uint8Array }>(
			this.db
				.prepare(`SELECT memory_id, body FROM pointers WHERE memory_id IN (${placeholders}) ORDER BY created_at`)
				.all(...memoryIds),
		);
		for (const row of rows) {
			const list = out.get(row.memory_id) ?? [];
			list.push(decrypt(this.key, row.body));
			out.set(row.memory_id, list);
		}
		return out;
	}

	/**
	 * Embeds the query, scores every stored memory, decrypts the top-k.
	 * `skippedDim` counts rows whose vectors came from a different embedding model and so could
	 * not be compared — reported to the caller rather than silently dropped.
	 */
	async surface(
		query: string,
		limit = TOP_K,
	): Promise<{ hits: SurfaceHit[]; skippedDim: number; total: number; bestMiss: number }> {
		const [qvec] = await embed([query]);
		const rows = asRows<MemoryRow>(
			this.db.prepare("SELECT id, body, emb, dim, score, sessions FROM memories").all(),
		);

		const ranked: Array<{ row: MemoryRow; similarity: number; rank: number }> = [];
		let skippedDim = 0;
		let bestMiss = 0;
		for (const row of rows) {
			if (row.dim !== qvec.length) {
				skippedDim++;
				continue;
			}
			const vec = new Float32Array(row.emb.buffer, row.emb.byteOffset, row.dim);
			const similarity = cosine(qvec, vec);
			if (similarity < MIN_COSINE) {
				if (similarity > bestMiss) bestMiss = similarity;
				continue;
			}
			const influence = Math.max(-SCORE_INFLUENCE_CAP, Math.min(SCORE_INFLUENCE_CAP, row.score * SCORE_WEIGHT));
			ranked.push({ row, similarity, rank: similarity + influence });
		}
		ranked.sort((a, b) => b.rank - a.rank);
		const top = ranked.slice(0, limit);

		const pointers = this.pointersFor(top.map((t) => t.row.id));
		const hits: SurfaceHit[] = top.map((t) => {
			const stamps = parseStamps(t.row.sessions);
			return {
				id: t.row.id,
				text: decrypt(this.key, t.row.body),
				score: Number(t.row.score.toFixed(2)),
				rank: Number(t.rank.toFixed(4)),
				similarity: Number(t.similarity.toFixed(4)),
				pointers: pointers.get(t.row.id) ?? [],
				session: stamps[stamps.length - 1] ?? "",
				stamps: stamps.length,
			};
		});

		if (hits.length > 0) {
			const bump = this.db.prepare("UPDATE memories SET surfaces = surfaces + 1 WHERE id = ?");
			for (const hit of hits) bump.run(hit.id);
		}
		return { hits, skippedDim, total: rows.length, bestMiss: Number(bestMiss.toFixed(4)) };
	}
}

/** Newest stamp wins: a repeated session id does not extend the chain. */
function appendStamp(stamps: string[], sessionId: string): string[] {
	return stamps[stamps.length - 1] === sessionId ? stamps : [...stamps, sessionId];
}

function parseStamps(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
}

// ── Result formatting ────────────────────────────────────────────────

interface SurfaceResult {
	hits: SurfaceHit[];
	skippedDim: number;
	total: number;
	bestMiss: number;
}

function renderSurface(result: SurfaceResult): string {
	const lines: string[] = [];

	if (result.total === 0) {
		lines.push("The durable memory store is empty. Nothing has been carried forward yet.");
		lines.push("");
		lines.push("Work the task. At the closeout, `create` the facts a future session would need.");
		lines.push(closeoutReminder());
		return lines.join("\n");
	}

	if (result.hits.length === 0) {
		lines.push(
			`No stored memory matched this distill (searched ${result.total}, nothing cleared the ${MIN_COSINE} cosine floor; ` +
				`the closest scored ${result.bestMiss}).`,
		);
		lines.push("");
		lines.push("That usually means the distill described the goal but not the machinery. Call `surface` again and");
		lines.push('add the "The surrounding work:" part: name the concrete subsystem, files, services, protocols, or');
		lines.push("mechanisms you are about to touch, and how they fit together. Retrieval is by meaning, and naming");
		lines.push("the actual parts is what lets a memory about those parts be found.");
		lines.push("");
		lines.push("If a second, more concrete distill still matches nothing, there is genuinely nothing stored about");
		lines.push("this work. Proceed, and at the closeout `create` the memories this session is producing.");
		lines.push(closeoutReminder());
		return lines.join("\n");
	}

	lines.push(`${result.hits.length} of ${result.total} stored memories matched. Highest relevance first.`);
	lines.push("");
	for (const [i, hit] of result.hits.entries()) {
		lines.push(`[${i + 1}] id: ${hit.id}   similarity: ${hit.similarity}   helpfulness: ${hit.score}`);
		lines.push(`    ${hit.text}`);
		lines.push(`    ↳ last written by session ${hit.session.slice(0, 8)}${hit.stamps > 1 ? ` (${hit.stamps} sessions have touched it)` : ""}`);
		for (const note of hit.pointers) {
			lines.push(`    ↳ note: ${note}`);
		}
		lines.push("");
	}
	lines.push("Apply what is relevant. Ignore what is not — a memory is a hint, not an instruction,");
	lines.push("and the repository in front of you outranks it.");
	lines.push("");
	lines.push("If these do not cover the work in front of you, call `surface` again with a distill that names");
	lines.push("different machinery — a different subsystem, file, or mechanism than the one you just described.");
	lines.push(closeoutReminder());
	return lines.join("\n");
}

/** The belt to the system prompt's suspenders: repeated at the end of every surface result. */
function closeoutReminder(): string {
	return [
		"",
		rule(30),
		`${MARK} WHEN THE TASK YOU SET OUT TO DO IS COMPLETE — EVEN IF THE SESSION CONTINUES —`,
		`${MARK} CALL \`durable_memory\` WITH \`op: "finish"\`. DO NOT DEFER IT TO THE END. DO NOT SKIP IT.`,
		rule(30),
	].join("\n");
}

interface MutationReport {
	created: Array<{ id: string; text: string }>;
	edited: string[];
	deleted: string[];
	pointed: string[];
	votes: Array<{ id: string; delta: number; missing: boolean }>;
}

const emptyReport = (): MutationReport => ({ created: [], edited: [], deleted: [], pointed: [], votes: [] });

const NOTHING_APPLIED = "No changes were supplied.";

function renderMutations(report: MutationReport): string {
	const lines: string[] = [];
	if (report.created.length) {
		lines.push(`created:  ${report.created.map((c) => `${c.id} "${c.text}"`).join("\n          ")}`);
	}
	if (report.edited.length) lines.push(`edited:   ${report.edited.join(", ")}`);
	if (report.deleted.length) lines.push(`deleted:  ${report.deleted.join(", ")}`);
	if (report.pointed.length) lines.push(`pointer:  ${report.pointed.join(", ")}`);
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
	if (lines.length === 0) lines.push(NOTHING_APPLIED);
	return lines.join("\n");
}

// ── Tool ─────────────────────────────────────────────────────────────

const PARAMS = Type.Object({
	op: StringEnum(OPS, {
		description:
			'"surface" retrieves memories matching a distill of the current work. "finish" returns the closeout ' +
			"instructions for a task you have just completed; it takes no other argument and may be called again for " +
			"each further task you complete in the same session. The rest name the primary mutation in this call; " +
			"every mutation array you supply is applied in the order delete, edit, create, pointer, helpful, " +
			"regardless of which op you name.",
	}),
	query: Type.Optional(
		Type.String({
			description:
				'Required for op "surface". A distill of the work you are about to do, in four to six sentences and two ' +
				"parts. First: three sentences stating the task, the constraint you are working under, and what a good " +
				"outcome looks like. Second, beginning on a new line after \"The surrounding work:\": two or three " +
				"sentences naming the concrete subsystem, files, services, or mechanisms you are about to touch and how " +
				"they fit together. Write it as a statement of the work, never as a question, and never as a request for " +
				"memories. The second part matters as much as the first: retrieval is by meaning, and naming the actual " +
				"machinery is what lets a memory about that machinery be found.",
		}),
	),
	create: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Memory texts to store. One self-contained sentence each, readable with no other context: a user " +
				'preference, a project convention, a constraint, a fix that worked. Example: ["The mira repo forbids mock ' +
				'objects in tests; verification runs live probes against real infrastructure."]',
		}),
	),
	edit: Type.Optional(
		Type.Array(Type.Object({ id: Type.String(), text: Type.String() }), {
			description: "Replace a stored memory's text. Re-embeds it and appends this session to its provenance chain.",
		}),
	),
	delete: Type.Optional(Type.Array(Type.String(), { description: "Ids of memories to remove permanently." })),
	pointer: Type.Optional(
		Type.Array(Type.Object({ id: Type.String(), note: Type.String() }), {
			description:
				"Attach a short caveat or cross-reference to an existing memory. The note is returned with that memory " +
				"on every future surface, and does not alter its text or embedding.",
		}),
	),
	helpful: Type.Optional(
		Type.Array(Type.Object({ id: Type.String(), helpful: Type.Boolean() }), {
			description:
				"Rate memories you were shown by `surface` this session. true raises their future ranking, false lowers " +
				"it. Rate every id you were shown, including the ones that were merely irrelevant.",
		}),
	),
});

const DESCRIPTION = [
	"Long-term memory that persists across sessions, encrypted at rest and searched by embedding similarity.",
	"",
	'Open a session with op "surface" once you understand the task. Pass `query`: three sentences stating the work,',
	'then a line starting "The surrounding work:" naming the concrete subsystem, files, or mechanisms you are about',
	"to touch. You get back the stored memories that match, each with a short id. Those memories are what previous",
	"sessions decided was worth carrying forward — user preferences, project conventions, constraints, fixes that worked.",
	"",
	"Retrieval matches on meaning, so a distill that states only the goal finds little, while one that also names the",
	"machinery finds the memory written about that machinery. If the first surface comes back empty, surface again with",
	"a more concrete distill rather than concluding that nothing is stored.",
	"",
	'Close each completed task with op "finish" — not the session, the task. It takes no other argument and returns',
	"fixed instructions telling you what to store and what to rate. Then batch that closeout into one call: create the",
	"new memories and rate every id you were shown, in a single tool call. Call it again for the next task you finish;",
	"do not defer it to the end of the session, because the end of the session is not something you can observe.",
	"",
	"Write memories that a future session can act on with no other context. Do not store this session's narration, and",
	"do not store what the repository already says plainly.",
].join("\n");

interface ToolDetails {
	op: string;
	query?: string;
	hits?: SurfaceHit[];
	report: MutationReport;
	sessionId: string;
}

const toolResult = (
	op: string,
	report: MutationReport,
	sessionId: string,
	text: string,
	extra?: Partial<ToolDetails>,
): AgentToolResult<ToolDetails> => ({ content: [{ type: "text", text }], details: { op, report, sessionId, ...extra } });

// ── Extension ────────────────────────────────────────────────────────

export default function durableMemoryExtension(pi: ExtensionAPI) {
	let store: MemoryStore | undefined;
	/** Ids shown to the model this session, for the operator-facing status line. */
	const surfacedThisSession = new Set<string>();
	let surfaceCalls = 0;
	let finishCalls = 0;

	/**
	 * Opened lazily, and reopened when the configured directory changes, so the settings command
	 * takes effect without a restart.
	 */
	const openStore = (): MemoryStore => {
		const paths = storePathsOf(loadConfig());
		if (store && store.paths.dir !== paths.dir) {
			store.close();
			store = undefined;
		}
		if (!store) store = new MemoryStore(paths);
		return store;
	};

	/**
	 * Applies every mutation array present on the call, in a fixed order.
	 *
	 * ACCEPTED-RESIDUAL: this runs for any `op`, including `surface` and `finish`, which is
	 * deliberate. Observed in a live run: a model that called `finish` twice, attaching ratings to
	 * the first and creates to the second, still had both stored because the payload is read
	 * independently of `op`. Gating mutations on the op name would turn that into silent data loss.
	 */
	async function applyMutations(
		params: {
			delete?: string[];
			edit?: Array<{ id: string; text: string }>;
			create?: string[];
			pointer?: Array<{ id: string; note: string }>;
			helpful?: Array<{ id: string; helpful: boolean }>;
		},
		sessionId: string,
	): Promise<MutationReport> {
		const hasAny =
			params.delete?.length || params.edit?.length || params.create?.length || params.pointer?.length || params.helpful?.length;
		if (!hasAny) return emptyReport();

		const db = openStore();
		const report = emptyReport();
		if (params.delete?.length) report.deleted = db.delete(params.delete);
		if (params.edit?.length) report.edited = await db.edit(params.edit, sessionId);
		if (params.create?.length) report.created = await db.create(params.create, sessionId);
		if (params.pointer?.length) report.pointed = await db.addPointers(params.pointer, sessionId);
		if (params.helpful?.length) report.votes = db.vote(params.helpful);
		return report;
	}

	const tool: ToolDefinition<typeof PARAMS, ToolDetails> = {
		name: "durable_memory",
		label: "Durable Memory",
		description: DESCRIPTION,
		promptSnippet: "Encrypted cross-session memory; surface it early, close it out at the end",
		promptGuidelines: [
			"If you have not yet called `durable_memory` with `op: \"surface\"` in this conversation, call it before your " +
				"next tool call. Check your own transcript for a previous `durable_memory` call rather than judging whether " +
				"you feel oriented — a task that needs no orientation is exactly the one where the check is skipped. Pass a " +
				"distill of the work: three sentences on the task and its constraint, then a line starting " +
				'"The surrounding work:" naming the subsystem, files, or mechanisms you are about to touch.',
			"If you have completed a task and have not called `durable_memory` with `op: \"finish\"` since completing it, " +
				"call it now — before reporting the result, and even if the session continues. Check your transcript for a " +
				"`finish` call after the task you just completed rather than waiting for the session to end, which is not " +
				"something you can observe.",
		],
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		parameters: PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("durable_memory call was aborted.");
			const sessionId = ctx.sessionManager.getSessionId();

			const report = await applyMutations(params, sessionId);

			if (params.op === "finish") {
				finishCalls++;
				return toolResult("finish", report, sessionId, FINISH_MESSAGE);
			}

			if (params.op === "surface") {
				const query = params.query?.trim();
				if (!query) throw new Error('op "surface" requires `query`: a three-sentence distill of the work.');
				const result = await openStore().surface(query);
				surfaceCalls++;
				for (const hit of result.hits) surfacedThisSession.add(hit.id);

				const lines = [renderSurface(result)];
				const mutated = renderMutations(report);
				if (mutated !== NOTHING_APPLIED) lines.push("", "Applied in the same call:", mutated);
				if (result.skippedDim > 0) {
					lines.push(
						"",
						`${result.skippedDim} stored ${result.skippedDim === 1 ? "memory was" : "memories were"} skipped: their vectors came ` +
							"from a different embedding model than the one now configured, so they cannot be compared. Tell the user — " +
							"those memories need re-embedding or deleting.",
					);
				}
				return toolResult("surface", report, sessionId, lines.join("\n"), { query, hits: result.hits });
			}

			return toolResult(params.op, report, sessionId, renderMutations(report));
		},
	};

	pi.registerTool(tool);

	const statusText = (ctx: { sessionManager: { getSessionId(): string } }): string => {
		try {
			const config = loadConfig();
			const paths = storePathsOf(config);
			const db = openStore();
			const cfg = resolveEmbedConfig(config);
			return [
				`memories:      ${db.count()}`,
				`db:            ${paths.db}`,
				`key:           ${paths.key}`,
				`settings:      ${CONFIG_PATH}`,
				`endpoint:      ${config.endpoint ?? "remote"} · ${cfg.model} @ ${cfg.url}`,
				`credential:    ${cfg.keySource}`,
				`stored vectors from: ${db.embedder() ?? "(none written yet)"}`,
				`session:       ${ctx.sessionManager.getSessionId()}`,
				`this session:  ${surfaceCalls} surface call(s), ${finishCalls} finish call(s), ${surfacedThisSession.size} distinct memories shown`,
			].join("\n");
		} catch (err) {
			return `durable memory unavailable: ${(err as Error).message}`;
		}
	};

	const maskKey = (key: string | undefined): string =>
		!key ? "not set" : `set (…${key.slice(-4)}, ${key.length} chars)`;

	/** Interactive settings loop. Each edit is written to disk immediately, so an abandoned menu keeps what was done. */
	const runSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
		for (;;) {
			const config = loadConfig();
			let paths: StorePaths;
			try {
				paths = storePathsOf(config);
			} catch (err) {
				// A bad stored directory must be fixable from here, not fatal.
				ctx.ui.notify((err as Error).message, "error");
				paths = { dir: "(invalid)", db: "", key: "" };
			}
			const endpoint = config.endpoint ?? "remote";
			const options = [
				`Endpoint      ${endpoint} — ${config.url ?? (endpoint === "local" ? LOCAL_EMBED_URL : REMOTE_EMBED_URL)}`,
				`Embedding model  ${config.model ?? DEFAULT_EMBED_MODEL}`,
				`Auth key      ${maskKey(config.apiKey)}`,
				`Database dir  ${paths.dir}`,
				`Show status`,
				`Done`,
			];
			const choice = await ctx.ui.select("Durable memory settings", options);
			if (!choice || choice === "Done") return;

			if (choice.startsWith("Endpoint")) {
				const picked = await ctx.ui.select("Where do embeddings run?", [
					`remote — hosted endpoint (${REMOTE_EMBED_URL})`,
					`local — server on this machine (${LOCAL_EMBED_URL})`,
				]);
				if (!picked) continue;
				const nextEndpoint = picked.startsWith("local") ? "local" : "remote";
				const defaultUrl = nextEndpoint === "local" ? LOCAL_EMBED_URL : REMOTE_EMBED_URL;
				const url = await ctx.ui.input("Endpoint URL (blank keeps the default)", config.url ?? defaultUrl);
				config.endpoint = nextEndpoint;
				config.url = url?.trim() || undefined;
				saveConfig(config);
				ctx.ui.notify(`endpoint: ${nextEndpoint} · ${config.url ?? defaultUrl}`, "info");
				continue;
			}

			if (choice.startsWith("Embedding model")) {
				const model = await ctx.ui.input(
					"Embedding model (changing this makes stored vectors incomparable)",
					config.model ?? DEFAULT_EMBED_MODEL,
				);
				if (model === undefined) continue;
				config.model = model.trim() || undefined;
				saveConfig(config);
				ctx.ui.notify(`model: ${config.model ?? DEFAULT_EMBED_MODEL}`, "info");
				continue;
			}

			if (choice.startsWith("Auth key")) {
				// Not masked by pi's input dialog: the value is on screen while typed.
				const key = await ctx.ui.input("Bearer token for the endpoint (blank clears it)", "paste the token");
				if (key === undefined) continue;
				config.apiKey = key.trim() || undefined;
				saveConfig(config);
				ctx.ui.notify(config.apiKey ? `auth key ${maskKey(config.apiKey)}` : "auth key cleared", "info");
				continue;
			}

			if (choice.startsWith("Database dir")) {
				const dir = await ctx.ui.input("Directory for memory.db and memory.key (blank restores the default)", paths.dir);
				if (dir === undefined) continue;
				const wanted = dir.trim();
				if (!wanted) {
					config.storeDir = undefined;
					saveConfig(config);
					ctx.ui.notify(`database dir: ${DEFAULT_STORE_DIR}`, "info");
					continue;
				}
				// Validate before saving: refuse a directory a package update would delete.
				try {
					storeDirOf({ ...config, storeDir: path.resolve(wanted) });
				} catch (err) {
					ctx.ui.notify((err as Error).message, "error");
					continue;
				}
				config.storeDir = path.resolve(wanted);
				saveConfig(config);
				try {
					fs.mkdirSync(config.storeDir, { recursive: true, mode: 0o700 });
				} catch (err) {
					ctx.ui.notify(`cannot create ${config.storeDir}: ${(err as Error).message}`, "error");
				}
				ctx.ui.notify(`database dir: ${config.storeDir}`, "info");
				continue;
			}

			if (choice === "Show status") ctx.ui.notify(statusText(ctx), "info");
		}
	};

	pi.registerCommand("durable-memory", {
		description: "Durable memory: configure endpoint, auth key, and database directory: /durable-memory",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "status" || !ctx.hasUI) {
				ctx.ui.notify(statusText(ctx), "info");
				return;
			}
			await runSettings(ctx);
		},
	});

	pi.on("session_start", () => {
		surfacedThisSession.clear();
		surfaceCalls = 0;
		finishCalls = 0;
	});

	pi.on("session_shutdown", () => {
		store?.close();
		store = undefined;
	});
}

export { DEFAULT_STORE_DIR, CONFIG_PATH, AGENT_DIR, FINISH_MESSAGE, TOP_K, MIN_COSINE, storePathsOf, loadConfig };
export type { DurableConfig, SurfaceHit, MutationReport, ToolDetails };
