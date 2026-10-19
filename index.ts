/**
 * Registers the `durable_memory` tool — encrypted long-term memory across pi sessions — and
 * the `/durable-memory` command for configuration and status. A session opens with `op:
 * "surface"` (a distill of the work) and records each completed task with `op: "checkpoint"`, which returns
 * fixed checkpoint instructions (create/rate/edit) batched into one further call, also fired after a commit.
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

// ── Settings ──────────────────────────────────────────────────────

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

/** Outside everything pi reconciles: a store beside index.ts is deleted by `pi update --extensions`. */
const DEFAULT_STORE_DIR = path.join(AGENT_DIR, "durable-memory");

/** Fixed, so that moving the store does not move the settings. */
const CONFIG_PATH = path.join(DEFAULT_STORE_DIR, "config.json");

const URLS = {
	remote: "https://gw.lunaroute.com/v1/embeddings",
	local: "http://localhost:8080/v1/embeddings",
};
type Endpoint = keyof typeof URLS;

/** Every setting has a value here; a missing config file is prefilled with them. */
const DEFAULTS = {
	endpoint: "remote" as Endpoint,
	url: URLS.remote,
	model: "emb-qwen3",
	storeDir: DEFAULT_STORE_DIR,
} satisfies Settings;

type Key = "endpoint" | "url" | "model" | "apiKey" | "storeDir";

interface Settings {
	endpoint?: Endpoint;
	url?: string;
	model?: string;
	apiKey?: string;
	storeDir?: string;
}

/** Settings with every default filled in — the shape the file has once prefilled. */
type Resolved = Settings & typeof DEFAULTS;

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
	const s = { ...DEFAULTS, ...(parsed as object) } as Resolved;
	return s;
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
	return {
		endpoint: s.endpoint,
		url: process.env.DURABLE_MEMORY_EMBED_URL ?? s.url,
		model: process.env.DURABLE_MEMORY_EMBED_MODEL ?? s.model,
		apiKey: fromEnv ?? s.apiKey,
		keySource: fromEnv ? "env" : s.apiKey ? "config" : "none",
		storeDir: assertStoreDir(process.env.DURABLE_MEMORY_DIR ?? s.storeDir),
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

/** DECLINED-ALTERNATIVE: hubness correction. +0.11 MRR on terse queries but +0.003 once the distill names the machinery, at O(n²·dim) per query. Revisit past a few thousand rows. */
const VOTE_STEP = 0.5;
const SCORE_WEIGHT = 0.05;
const SCORE_INFLUENCE_CAP = 0.25;

const OPS = ["surface", "checkpoint", "create", "pointer", "edit", "delete", "helpful"] as const;
type Op = (typeof OPS)[number];

/**
 * Returned verbatim on every `checkpoint` call. Task-scoped, not session-scoped: a model cannot
 * observe "the session is ending", but it can observe "the task is done".
 */
const CHECKPOINT_MESSAGE = [
	`${rule()} CHECKPOINT — RECORD WHAT YOU LEARNED ${rule()}`,
	"",
	"You just completed a unit of work. Batch the following into ONE `durable_memory` call:",
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
	"This is not the end of the session. If you take on another task, call `checkpoint` again when",
	"that one is complete.",
	"",
	"Submit all of it in ONE call whose `op` is `create` — not another `checkpoint`, and not one call",
	"per item. If nothing you learned is worth carrying forward, send only the ratings and leave",
	"`create` out entirely: a memory recording that a task was routine is itself silt, and an empty",
	"checkpoint call is the correct answer to a routine task.",
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

/** Creates the store directory if absent (0700) and the keyfile on first use (0600). */
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

/** OpenAI-compatible /embeddings. Throws on any non-2xx or malformed response — no silent zeros. */
async function embed(texts: string[]): Promise<Float32Array[]> {
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

function asRow<T>(row: unknown): T | undefined {
	return row as T | undefined;
}
function asRows<T>(rows: unknown): T[] {
	return rows as T[];
}
function toBlob(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

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
	pointers: string[];
	/** Newest stamp in the provenance chain — the session that last wrote this memory. */
	session: string;
	/** How many sessions have touched it. */
	stamps: number;
}

export class MemoryStore {
	private db: DatabaseSync;
	private key: Buffer;
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
		this.key = loadKey(path.join(dir, "memory.key"));
		this.db = new DatabaseSync(path.join(dir, "memory.db"));
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS memories (
				id         TEXT PRIMARY KEY,
				body       BLOB NOT NULL,
				emb        BLOB NOT NULL,
				score      REAL NOT NULL DEFAULT 0,
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
			// Reload, session replacement, and process exit all converge here.
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

	private setEmbedder(value: string): void {
		this.db.prepare("INSERT INTO meta (k, v) VALUES ('embedder', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(value);
	}

	count(): number {
		return Number(asRow<{ n: number | bigint }>(this.db.prepare("SELECT COUNT(*) AS n FROM memories").get())?.n ?? 0);
	}

	/**
	 * Vectors are comparable only within one embedding model, and the same model varies slightly
	 * across runs — so the model name is the truth, never vector comparison. When it differs from
	 * the configured model, every embedding is regenerated.
	 */
	private async ensureEmbeddings(): Promise<void> {
		const model = resolveSettings().model;
		if (this.embedder() === model) return;
		const rows = asRows<{ id: string; body: Uint8Array }>(this.db.prepare("SELECT id, body FROM memories").all());
		const vectors = await embed(rows.map((row) => decrypt(this.key, row.body)));
		const update = this.db.prepare("UPDATE memories SET emb = ?, updated_at = ? WHERE id = ?");
		const now = Date.now();
		this.db.exec("BEGIN");
		try {
			rows.forEach((row, i) => update.run(toBlob(vectors[i]), now, row.id));
			this.setEmbedder(model);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	async create(texts: string[], sessionId: string): Promise<Array<{ id: string; text: string }>> {
		const clean = texts.map((t) => t.trim()).filter((t) => t.length > 0);
		if (clean.length === 0) return [];
		await this.ensureEmbeddings();
		const vectors = await embed(clean);
		const now = Date.now();
		const insert = this.db.prepare(
			"INSERT INTO memories (id, body, emb, score, sessions, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
		);
		const created: Array<{ id: string; text: string }> = [];
		this.db.exec("BEGIN");
		try {
			for (let i = 0; i < clean.length; i++) {
				const id = this.newId("memories");
				insert.run(id, encrypt(this.key, clean[i]), toBlob(vectors[i]), JSON.stringify([sessionId]), now, now);
				created.push({ id, text: clean[i] });
			}
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
		return created;
	}

	async edit(items: Array<{ id: string; text: string }>, sessionId: string): Promise<string[]> {
		const rows = items.map((item) => {
			const row = this.findById(item.id);
			if (!row) throw new Error(`edit: no memory with id "${item.id}".`);
			const text = item.text.trim();
			if (!text) throw new Error(`edit: replacement text for "${item.id}" was empty.`);
			return { row, text };
		});
		const vectors = await embed(rows.map((r) => r.text)); // one HTTP round trip for the whole batch
		const update = this.db.prepare("UPDATE memories SET body = ?, emb = ?, sessions = ?, updated_at = ? WHERE id = ?");
		rows.forEach(({ row, text }, i) => {
			const stamps = parseStamps(row.sessions);
			const chain = stamps[stamps.length - 1] === sessionId ? stamps : [...stamps, sessionId];
			update.run(encrypt(this.key, text), toBlob(vectors[i]), JSON.stringify(chain), Date.now(), row.id);
		});
		return rows.map((r) => r.row.id);
	}

	delete(ids: string[]): string[] {
		const stmt = this.db.prepare("DELETE FROM memories WHERE id = ?");
		for (const id of ids) {
			if (!this.findById(id)) throw new Error(`delete: no memory with id "${id}".`);
			stmt.run(id);
		}
		return ids;
	}

	async addPointers(items: Array<{ id: string; note: string }>, sessionId: string): Promise<string[]> {
		const insert = this.db.prepare(
			"INSERT INTO pointers (id, memory_id, body, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
		);
		const added: string[] = [];
		for (const item of items) {
			const row = this.findById(item.id);
			if (!row) throw new Error(`pointer: no memory with id "${item.id}".`);
			const note = item.note.trim();
			if (!note) throw new Error(`pointer: note for "${item.id}" was empty.`);
			const id = this.newId("pointers");
			insert.run(id, row.id, encrypt(this.key, note), sessionId, Date.now());
			added.push(id);
		}
		return added;
	}

	/** true moves a memory up future rankings, false sinks it toward silt. */
	vote(items: Array<{ id: string; helpful: boolean }>): Array<{ id: string; delta: number; missing: boolean }> {
		const out: Array<{ id: string; delta: number; missing: boolean }> = [];
		const bump = this.db.prepare("UPDATE memories SET score = score + ?, updated_at = ? WHERE id = ?");
		for (const item of items) {
			const row = this.findById(item.id);
			const delta = item.helpful ? VOTE_STEP : -VOTE_STEP;
			if (!row) {
				out.push({ id: item.id, delta, missing: true });
				continue;
			}
			bump.run(delta, Date.now(), row.id);
			out.push({ id: row.id, delta, missing: false });
		}
		return out;
	}

	private findById(id: string): MemoryRow | undefined {
		return asRow<MemoryRow>(
			this.db.prepare("SELECT id, body, emb, score, sessions FROM memories WHERE id = ?").get(id),
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

	/** Embeds the query, scores every stored memory, decrypts the top-k. */
	async surface(query: string, limit = TOP_K): Promise<SurfaceResult> {
		await this.ensureEmbeddings();
		const [qvec] = await embed([query]);
		const rows = asRows<MemoryRow>(
			this.db.prepare("SELECT id, body, emb, score, sessions FROM memories").all(),
		);

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
		const top = ranked.slice(0, limit);

		const pointers = this.pointersFor(top.map((t) => t.row.id));
		const hits: SurfaceHit[] = top.map((t) => {
			const stamps = parseStamps(t.row.sessions);
			return {
				id: t.row.id,
				text: decrypt(this.key, t.row.body),
				score: Number(t.row.score.toFixed(2)),
				similarity: Number(t.similarity.toFixed(4)),
				pointers: pointers.get(t.row.id) ?? [],
				session: stamps[stamps.length - 1],
				stamps: stamps.length,
			};
		});

		return { hits, total: rows.length, bestMiss: Number(bestMiss.toFixed(4)) };
	}
}

function parseStamps(raw: string): string[] {
	return JSON.parse(raw) as string[];
}

// ── Result formatting ────────────────────────────────────────────────

interface SurfaceResult {
	hits: SurfaceHit[];
	total: number;
	bestMiss: number;
}

function renderSurface(result: SurfaceResult): string {
	const lines: string[] = [];

	if (result.total === 0) {
		lines.push("The durable memory store is empty. Nothing has been carried forward yet.");
		lines.push("");
		lines.push("Work the task. At the checkpoint, `create` the facts a future session would need.");
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
		lines.push("this work. Proceed, and at the checkpoint `create` the memories this session is producing.");
		lines.push(checkpointReminder());
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
	lines.push("If these do not cover the work, surface again with a distill naming different machinery.");
	lines.push("Surface again too when you move to a new subsystem even if these matched — memories from one");
	lines.push("surface may not cover the next, and re-surfacing is cheap.");
	lines.push(checkpointReminder());
	return lines.join("\n");
}

function checkpointReminder(): string {
	return [
		"",
		rule(30),
		`${MARK} WHEN THE TASK YOU SET OUT TO DO IS COMPLETE — OR AFTER A COMMIT — CALL`,
		`${MARK} \`durable_memory\` WITH \`op: "checkpoint"\`. DO NOT DEFER IT TO THE END. DO NOT SKIP IT.`,
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

const hasMutations = (report: MutationReport): boolean => Object.values(report).some((a) => a.length > 0);

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
	return lines.join("\n");
}

// ── Tool ─────────────────────────────────────────────────────────────

const PARAMS = Type.Object({
	op: StringEnum(OPS, {
		description:
			'"surface" retrieves memories matching a distill of the current work. "checkpoint" returns the recording ' +
			"instructions for the task you have just completed; it takes no other argument and may be called again for " +
			"each further task you complete in the same session. The rest name the primary mutation in this call; " +
			"every mutation array you supply is applied in the order delete, edit, create, pointer, helpful, " +
			"regardless of which op you name. Ids are the full ids `surface` returned — a prefix or unknown id is an error.",
	}),
	query: Type.Optional(
		Type.String({
			description:
				'Required for op "surface". A distill of the work you are about to do, in one to three sentences — as ' +
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
	delete: Type.Optional(Type.Array(Type.String(), { description: "Full ids of memories to remove permanently." })),
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
	'Call op "surface" before your first edit, write, or command that changes state (reading files first is fine),',
	"passing `query`: a distill of the work, shaped as the parameter description specifies. You get back memories previous",
	"sessions decided were worth carrying forward: user preferences, project conventions, constraints, fixes that worked.",
	"",
	'Close each completed task — and call again after a commit — with op "checkpoint", not the session, the task. It takes no',
	"other argument and returns the recording instructions for that moment, so deferring it to the end of the session",
	"is neither needed nor possible.",
].join("\n");

interface ToolDetails {
	op: string;
	hits?: SurfaceHit[];
	report: MutationReport;
}

const toolResult = (op: string, report: MutationReport, text: string, extra?: Partial<ToolDetails>): AgentToolResult<ToolDetails> => ({
	content: [{ type: "text", text }],
	details: { op, report, ...extra },
});

// ── Extension ────────────────────────────────────────────────────────

export default function durableMemoryExtension(pi: ExtensionAPI) {
	let store: MemoryStore | undefined;
	let surfaceCalls = 0;

	/** Opened lazily, once; a store-dir change takes effect when pi is reopened. */
	const openStore = (): MemoryStore => (store ??= new MemoryStore(resolveSettings().storeDir));

	/**
	 * Applies every mutation array present, in a fixed order. Runs for any `op`, including
	 * `surface` and `checkpoint` — deliberately: observed live, a model that called `checkpoint` twice
	 * (ratings on the first, creates on the second) still had both stored because the payload
	 * is read independently of `op`. Gating on op would turn that into silent data loss.
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
		promptSnippet: "Encrypted cross-session memory; surface early and often, close out each task",
		promptGuidelines: [
			"If you have not yet called `durable_memory` with `op: \"surface\"` in this conversation, call it before your " +
				"first edit, write, or command that changes state. Reading files first is fine and expected — surface " +
				"before you act, not before you look. Check your own transcript for a previous `durable_memory` call " +
				"rather than judging whether you feel oriented — a task that needs no orientation is exactly the one " +
				"where the check is skipped.",
			"Surface is not a one-time check — it is a habit across the session. Call `durable_memory` with " +
				'`op: "surface"` again whenever the work pivots to a different subsystem, file, or mechanism than the ' +
				"one you last surfaced for, and whenever a new task begins. An earlier surface may not cover the new " +
				"ground, and re-surfacing is cheap.",
			"When you complete a task or commit, call `durable_memory` with `op: \"checkpoint\"` before reporting " +
				"the result — even if the session continues. Check your transcript for a `checkpoint` call after that " +
				"task or commit rather than waiting for the session to end, which is not something you can observe.",
		],
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		parameters: PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("durable_memory call was aborted.");
			const sessionId = ctx.sessionManager.getSessionId();

			const report = await applyMutations(params, sessionId);
			// A mutation op that applied nothing is a malformed call — reject it, don't render it.
			if (params.op !== "surface" && params.op !== "checkpoint" && !hasMutations(report)) {
				throw new Error(
					`op "${params.op}" applied nothing — supply at least one well-formed mutation array ` +
						"(delete, edit, create, pointer, helpful).",
				);
			}

			if (params.op === "checkpoint") {
				return toolResult("checkpoint", report, CHECKPOINT_MESSAGE);
			}

			if (params.op === "surface") {
				const query = params.query?.trim();
				if (!query) throw new Error('op "surface" requires `query`: a distill of the work (one to three sentences).');
				const result = await openStore().surface(query);
				surfaceCalls++;

				const lines = [renderSurface(result)];
				if (hasMutations(report)) lines.push("", "Applied in the same call:", renderMutations(report));
				return toolResult("surface", report, lines.join("\n"), { hits: result.hits });
			}

			return toolResult(params.op, report, renderMutations(report));
		},
	};

	pi.registerTool(tool);

	const statusText = (ctx: { sessionManager: { getSessionId(): string } }): string => {
		try {
			const r = resolveSettings();
			const db = openStore();
			return [
				`memories:  ${db.count()}`,
				`store:     ${db.dir}`,
				`settings:  ${CONFIG_PATH}`,
				`endpoint:  ${r.endpoint} · ${r.model} @ ${r.url}`,
				`auth key:  ${r.keySource}`,
				`vectors:   ${db.embedder() ?? "none written yet"}`,
				`session:   ${ctx.sessionManager.getSessionId()}`,
				`this session: ${surfaceCalls} surface call${surfaceCalls === 1 ? "" : "s"}`,
			].join("\n");
		} catch (err) {
			return `durable memory unavailable: ${(err as Error).message}`;
		}
	};

	/** Each edit writes immediately; the redrawn rows are the confirmation. */
	const runSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
		for (;;) {
			const s = readSettings();
			const r = resolveSettings();
			const rows: Array<[Key | "status" | "done", string]> = [
				["endpoint", `Endpoint        ${r.endpoint} — ${r.url}`],
				["url", `URL             ${r.url}`],
				["model", `Embedding model ${r.model}`],
				["apiKey", `Auth key        ${r.apiKey ? `set (…${r.apiKey.slice(-4)})` : "not set"}`],
				["storeDir", `Database dir    ${r.storeDir}`],
				["status", "Show status"],
				["done", "Done"],
			];
			const picked = await ctx.ui.select("Durable memory", rows.map(([, label]) => label));
			const key = rows.find(([, label]) => label === picked)?.[0];
			if (!key || key === "done") return;
			if (key === "status") {
				ctx.ui.notify(statusText(ctx), "info");
				continue;
			}

			if (key === "endpoint") {
				const chosen = await ctx.ui.select("Embeddings run on", [
					`remote — hosted (${URLS.remote})`,
					`local — this machine (${URLS.local})`,
				]);
				if (!chosen) continue;
				const endpoint: Endpoint = chosen.startsWith("local") ? "local" : "remote";
				writeSettings({ ...s, endpoint, url: URLS[endpoint] }); // the preset carries its URL
				continue;
			}

			if (key === "url") {
				const typed = await ctx.ui.input("Embeddings URL (blank restores the endpoint's)", r.url);
				if (typed !== undefined) writeSettings({ ...s, url: typed.trim() || URLS[s.endpoint ?? "remote"] });
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
			const arg = args.trim().toLowerCase();
			if (arg === "status" || !ctx.hasUI) {
				ctx.ui.notify(statusText(ctx), "info");
				return;
			}
			await runSettings(ctx);
		},
	});

	pi.on("session_start", () => {
		surfaceCalls = 0;
	});

	pi.on("session_shutdown", () => {
		store?.close();
		store = undefined;
	});
}

export { DEFAULT_STORE_DIR, CONFIG_PATH, resolveSettings, readSettings };
