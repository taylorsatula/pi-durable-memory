#!/usr/bin/env node
// Standalone seeder for a global pi-durable-memory store.
// Usage: node scripts/seed-global.mjs --dir /path/to/global --file corpus.txt [--model emb-qwen3] [--url https://gw.lunaroute.com/v1/embeddings]

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg("--dir");
const file = arg("--file");
const model = arg("--model") ?? "emb-qwen3";
const url = arg("--url") ?? "https://gw.lunaroute.com/v1/embeddings";
const apiKey = process.env.DURABLE_MEMORY_EMBED_KEY ?? "";

if (!dir || !file) {
  console.error("Usage: node scripts/seed-global.mjs --dir <storeDir> --file <corpus.txt>");
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const db = new DatabaseSync(path.join(dir, "memory.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, body BLOB NOT NULL, emb BLOB NOT NULL, dim INTEGER NOT NULL,
    score REAL NOT NULL DEFAULT 0, surfaces INTEGER NOT NULL DEFAULT 0,
    sessions TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

async function embed(texts) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

const vectors = await embed(lines);
const now = Date.now();
const insert = db.prepare(
  "INSERT INTO memories (id, body, emb, dim, score, surfaces, sessions, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, '[]', ?, ?)",
);
db.exec("BEGIN");
let n = 0;
for (let i = 0; i < lines.length; i++) {
  const id = (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).slice(0, 8);
  insert.run(id, Buffer.from(lines[i], "utf8"), Buffer.from(new Float32Array(vectors[i]).buffer), vectors[i].length, now, now);
  n++;
}
db.prepare("INSERT INTO meta (k, v) VALUES ('embedder', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(model);
db.prepare("INSERT INTO meta (k, v) VALUES ('encrypted', 'false') ON CONFLICT(k) DO UPDATE SET v = excluded.v").run();
db.exec("COMMIT");
console.log(`Seeded ${n} memories into ${dir}/memory.db (model ${model}).`);
db.close();
