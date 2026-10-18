#!/usr/bin/env node
/**
 * digest.mjs — compress one pi session JSONL into a readable transcript digest.
 *
 * Usage: node /tmp/dmharvest/digest.mjs <session.jsonl> [maxBytes]
 *
 * Prints: session header (id, cwd, timestamp, models), every user message verbatim,
 * assistant text blocks, and one line per tool call (name + its most identifying arg).
 * Tool RESULTS are omitted except for a short head, so the digest fits in a context.
 */
import * as fs from "node:fs";

const file = process.argv[2];
const maxBytes = Number(process.argv[3] ?? 60_000);
if (!file) {
	console.error("usage: digest.mjs <session.jsonl> [maxBytes]");
	process.exit(2);
}

const clip = (s, n) => {
	const t = String(s ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
	return t.length > n ? t.slice(0, n) + ` …[+${t.length - n}b]` : t;
};

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const out = [];
let session = null;
const models = new Set();

const push = (s) => {
	out.push(s);
};

for (const line of lines) {
	let e;
	try {
		e = JSON.parse(line);
	} catch {
		continue;
	}
	if (e.type === "session") {
		session = e;
		continue;
	}
	if (e.type === "model_change") {
		models.add(`${e.provider}/${e.modelId}`);
		continue;
	}
	if (e.type !== "message" || !e.message) continue;
	const m = e.message;

	if (m.role === "user") {
		const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
		const text = parts
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("\n");
		// Skip tool-result carrier messages and system-injected noise.
		if (!text.trim()) continue;
		if (/^\[?(system|pi)\b/i.test(text.trim()) && text.length < 200) continue;
		push(`\n### USER\n${clip(text, 2500)}`);
	} else if (m.role === "assistant") {
		const parts = Array.isArray(m.content) ? m.content : [];
		for (const p of parts) {
			if (p.type === "text" && p.text?.trim()) {
				push(`\n--- ASSISTANT\n${clip(p.text, 1400)}`);
			} else if (p.type === "toolCall" || p.type === "tool_use" || p.type === "toolUse") {
				const name = p.name ?? p.toolName ?? "?";
				const a = p.arguments ?? p.input ?? p.args ?? {};
				let id = "";
				if (typeof a === "object" && a !== null) {
					id = a.path ?? a.file_path ?? a.filename ?? a.command ?? a.pattern ?? a.query ?? a.url ?? a.name ?? a.id ?? "";
				}
				push(`  [tool] ${name} ${clip(String(id), 160).replace(/\n/g, " ⏎ ")}`);
			}
		}
	} else if (m.role === "toolResult" || m.role === "tool") {
		const c = m.content;
		const text = Array.isArray(c) ? c.filter((p) => p.type === "text").map((p) => p.text).join("\n") : String(c ?? "");
		if (text.trim()) push(`    ↳ ${clip(text, 220).replace(/\n/g, " ⏎ ")}`);
	}
}

const header = [
	`SESSION_ID: ${session?.id ?? "(unknown)"}`,
	`CWD: ${session?.cwd ?? "(unknown)"}`,
	`TIMESTAMP: ${session?.timestamp ?? "(unknown)"}`,
	`MODELS: ${[...models].join(", ") || "(none recorded)"}`,
	`ENTRIES: ${lines.length}`,
	"=".repeat(70),
].join("\n");

let body = out.join("\n");
const budget = Math.max(4000, maxBytes - header.length);
if (body.length > budget) {
	const head = body.slice(0, Math.floor(budget * 0.6));
	const tail = body.slice(body.length - Math.floor(budget * 0.35));
	body = `${head}\n\n…[ ${body.length - head.length - tail.length} bytes elided from the middle ]…\n\n${tail}`;
}
process.stdout.write(header + "\n" + body + "\n");
