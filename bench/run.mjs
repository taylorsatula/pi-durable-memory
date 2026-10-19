/**
 * run.mjs — retrieval-accuracy benchmark. The witness for MIN_COSINE and TOP_K in ../index.ts.
 *
 * Loads a harvested corpus (see README.md), embeds it once through the real gateway with a
 * local cache, then reports recall/MRR across a floor x K sweep for two query styles, plus
 * how many off-topic control queries leak through each floor. The shipped constants are the
 * maximum-margin floor and the recall knee.
 *
 * Usage: node bench/run.mjs [--no-cache]
 * Reads:  bench/corpus.json  bench/neg.json
 * Writes: bench/embcache.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HERE = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const CORPUS_PATH = path.join(HERE, "corpus.json");
const NEG_PATH = path.join(HERE, "neg.json");
const CACHE_PATH = path.join(HERE, "embcache.json");

const MODEL = process.env.DURABLE_MEMORY_EMBED_MODEL ?? "emb-qwen3";
const URL = process.env.DURABLE_MEMORY_EMBED_URL ?? "https://gw.lunaroute.com/v1/embeddings";

if (!fs.existsSync(CORPUS_PATH)) {
	console.error(`${CORPUS_PATH} is missing. Build one with digest.mjs — see README.md. It is not published with the package.`);
	process.exit(2);
}
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")).memories;
const negatives = JSON.parse(fs.readFileSync(NEG_PATH, "utf8"));
const N = corpus.length;

/** The credential chain mirrors ../index.ts: an explicit override, else the config file, else pi's auth.json entry. */
function credential() {
	if (process.env.DURABLE_MEMORY_EMBED_KEY) return process.env.DURABLE_MEMORY_EMBED_KEY;
	const cfgPath = path.join(os.homedir(), ".pi", "agent", "durable-memory", "config.json");
	if (fs.existsSync(cfgPath)) {
		const key = JSON.parse(fs.readFileSync(cfgPath, "utf8")).apiKey;
		if (key) return key;
	}
	const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	const provider = process.env.DURABLE_MEMORY_EMBED_PROVIDER ?? "lunaroute";
	const entry = JSON.parse(fs.readFileSync(authPath, "utf8"))[provider];
	const key = entry?.key ?? entry?.access;
	if (!key) throw new Error(`No credential for provider "${provider}" in ${authPath}.`);
	return key;
}

const cacheKey = (s) => s.replace(/\s+/g, " ").trim();
const useCache = !process.argv.includes("--no-cache");
const cache = useCache && fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) : {};

async function embed(texts) {
	const token = credential();
	const out = new Array(texts.length);
	const missing = [];
	texts.forEach((t, i) => {
		const hit = cache[cacheKey(t)];
		if (hit) out[i] = Float32Array.from(hit);
		else missing.push(i);
	});
	for (let b = 0; b < missing.length; b += 16) {
		const batch = missing.slice(b, b + 16);
		const inputs = batch.map((i) => texts[i]);
		const res = await fetch(URL, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ model: MODEL, input: inputs }),
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${URL}: ${(await res.text()).slice(0, 300)}`);
		const json = await res.json();
		if (!Array.isArray(json.data) || json.data.length !== inputs.length) {
			throw new Error(`gateway returned ${json.data?.length ?? 0} vectors for ${inputs.length} inputs`);
		}
		// Keyed by the batch-local index the provider echoes back, never by array position.
		const byIndex = new Map(json.data.map((d) => [d.index, d.embedding]));
		batch.forEach((globalIndex, localIndex) => {
			const vec = byIndex.get(localIndex);
			if (!vec) throw new Error(`no vector returned for batch position ${localIndex}`);
			cache[cacheKey(texts[globalIndex])] = vec;
			out[globalIndex] = Float32Array.from(vec);
		});
	}
	if (useCache) fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
	return out;
}

function cos(a, b) {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	const den = Math.sqrt(na) * Math.sqrt(nb);
	return den === 0 ? 0 : dot / den;
}

/**
 * The query the tool contract asks for: three sentences on the task, then the surrounding work.
 * A corpus entry carries `query` (the three sentences) and `synopsis` (an independently worded
 * description of the surrounding code) so the two halves can be varied separately.
 */
const RICH = (m) => `${m.query}\n\nThe surrounding work: ${m.synopsis}`;

const memVecs = await embed(corpus.map((m) => m.memory));
const styles = {
	terse: await embed(corpus.map((m) => m.query)),
	rich: await embed(corpus.map(RICH)),
};
const negVecs = await embed(negatives);

const sim = { terse: styles.terse.map((q) => memVecs.map((m) => cos(q, m))), rich: styles.rich.map((q) => memVecs.map((m) => cos(q, m))) };
const negSim = negVecs.map((q) => memVecs.map((m) => cos(q, m)));

function measure(kind, floor, K) {
	const ranks = [];
	let shown = 0, nothing = 0;
	for (let q = 0; q < N; q++) {
		const passed = sim[kind][q].map((s, m) => ({ m, s })).filter((x) => x.s >= floor).sort((a, b) => b.s - a.s);
		if (passed.length === 0) nothing++;
		const top = passed.slice(0, K);
		shown += top.length;
		ranks.push(top.findIndex((x) => x.m === q) + 1);
	}
	const at = (k) => ranks.filter((r) => r > 0 && r <= k).length;
	return { at, mrr: ranks.reduce((a, r) => a + (r > 0 ? 1 / r : 0), 0) / N, shown: shown / N, nothing, ranks };
}

const richTrue = sim.rich.map((row, q) => row[q]);
const terseTrue = sim.terse.map((row, q) => row[q]);
const negMax = negSim.map((row) => Math.max(...row));
const sorted = (a) => [...a].sort((x, y) => x - y);

console.log(`embedder ${MODEL} · corpus n=${N} · off-topic controls n=${negatives.length}\n`);
console.log("similarity distributions");
console.log(`  rich-query true match   min ${Math.min(...richTrue).toFixed(4)}  median ${sorted(richTrue)[N >> 1].toFixed(4)}`);
console.log(`  terse-query true match  min ${Math.min(...terseTrue).toFixed(4)}  median ${sorted(terseTrue)[N >> 1].toFixed(4)}`);
console.log(`  off-topic best match    max ${Math.max(...negMax).toFixed(4)}  p90 ${sorted(negMax)[Math.floor(negMax.length * 0.9)].toFixed(4)}`);
const midpoint = (Math.min(...richTrue) + Math.max(...negMax)) / 2;
console.log(`  maximum-margin floor    ${midpoint.toFixed(4)}  (midpoint of the two above)\n`);

console.log("floor sweep at the shipped K=8");
console.log(" floor | off-topic leaked | terse @6  MRR  | rich @6  @8  MRR  | shown/query | rich empty");
console.log("-------+------------------+----------------+------------------+-------------+-----------");
for (let f = 0.30; f <= 0.54; f += 0.01) {
	const t = measure("terse", f, 8), r = measure("rich", f, 8);
	const leak = negMax.filter((s) => s >= f).length;
	const mark = leak === 0 && Math.min(...richTrue) >= f && Math.min(...terseTrue) >= f - 0.06 ? "  <== viable" : "";
	console.log(
		`  ${f.toFixed(2)} |        ${String(leak).padStart(2)}        |   ${String(t.at(6)).padStart(2)}   ${t.mrr.toFixed(3)}  |   ${String(r.at(6)).padStart(2)}   ${String(r.at(8)).padStart(2)}  ${r.mrr.toFixed(3)}  |     ${r.shown.toFixed(1)}     |     ${r.nothing}${mark}`,
	);
}

console.log("\nK sweep at the shipped floor");
const shippedFloor = Number(process.env.BENCH_FLOOR ?? midpoint.toFixed(2));
console.log(`  (floor ${shippedFloor})`);
console.log("   K | terse @K  MRR  | rich @K  MRR  | shown/query");
console.log("-----+----------------+---------------+------------");
for (const K of [3, 4, 5, 6, 7, 8, 10, 12, 16, 24]) {
	const t = measure("terse", shippedFloor, K), r = measure("rich", shippedFloor, K);
	console.log(`  ${String(K).padStart(2)} |   ${String(t.at(K)).padStart(2)}   ${t.mrr.toFixed(3)}  |   ${String(r.at(K)).padStart(2)}   ${r.mrr.toFixed(3)}  |     ${r.shown.toFixed(1)}`);
}

console.log("\nresidual misses at the shipped floor and K=8");
const r8 = measure("rich", shippedFloor, 8);
for (let q = 0; q < N; q++) {
	if (r8.ranks[q] === 0 || r8.ranks[q] > 8) {
		const c = corpus[q];
		console.log(`  ${c.id} rank=${r8.ranks[q] || "below floor"} true sim ${sim.rich[q][q].toFixed(4)} [${c.category}]`);
		console.log(`     ${c.memory.slice(0, 150)}`);
	}
}
