#!/usr/bin/env node
// Dump every stored memory as plaintext, oldest first, for a refinement pass to read in full.
//
//   node scripts/refine-dump.mjs [--dir <storeDir>] [--index]
//
// --index prints one line per row (seq, id, first 78 chars) instead of full text: the map an agent
// uses to group rows before reading the groups it needs in full. Without it, prints full text.
//
// Reads the store read-only where it can. Bodies are AES-256-GCM as iv(12) || tag(16) || ciphertext
// when meta.encrypted is true, and plain utf8 when it is not; both are handled.

import { createDecipheriv } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = arg("--dir", join(homedir(), ".pi", "agent", "durable-memory"));
const indexPath = join(dir, "memory.db");
if (!existsSync(indexPath)) {
	console.error(`No memory database at ${indexPath}`);
	process.exit(1);
}

const db = new DatabaseSync(indexPath, { readOnly: true });
const meta = (k) => db.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v;
const encrypted = meta("encrypted") === "true";
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

const rows = db.prepare("SELECT id, body, score, sessions, created_at FROM memories ORDER BY created_at, id").all();
const asIndex = process.argv.includes("--index");
const out = [];
rows.forEach((r, i) => {
	const text = decode(r.body).replace(/\s+/g, " ").trim();
	const seq = String(i + 1).padStart(3, "0");
	if (asIndex) {
		out.push(`${seq} ${r.id} ${text.slice(0, 78)}`);
		return;
	}
	const stamps = JSON.parse(r.sessions).length;
	out.push(`### ${seq} ${r.id} score=${Number(r.score).toFixed(1)} sessions=${stamps} created=${r.created_at}`);
	out.push(decode(r.body));
	out.push("");
});

process.stdout.write(out.join("\n") + "\n");
console.error(
	`rows: ${rows.length}  encrypted: ${encrypted}  directive: ${meta("directive") ?? "none"}  ` +
		`legacy_rows: ${meta("legacy_rows") ?? "none"}`,
);
db.close();
