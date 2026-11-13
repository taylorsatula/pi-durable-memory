# Refinement pass over an existing memory store

A one-time rewrite of the memories already in the store, bringing rows written before the current
create directive up to its shape. The agent runs it end to end. The user asks for it and reads the
report; they do not step through the work.

Run it when the `surface` byline offers it, or whenever the user asks. It is safe to run more than
once: a store already in shape produces an empty plan.

## What it costs

The pass reads every stored memory into the agent's context, so cost scales with the corpus, not
with the work being done. A 400-row store is roughly 200k characters of decrypted text. Embedding
calls scale with the number of rows written, batched eight at a time. Plan for a long turn and say
so before starting.

## Authorization

The user asking for a refinement pass is the authorization to write. Do not ask again mid-pass, and
do not present a row-by-row approval list. Two things stand in for step-through approval:

- A backup is written before anything changes, so the whole pass is revertible by copying one file
  back over `memory.db`.
- A coverage gate rejects any rewrite that drops an identity-bearing token, so the pass cannot
  silently lose a path, a commit sha, a version, or a measured number.

Report at the end: what was merged, split, rewritten, and deleted, with counts and the before/after
shape of the corpus.

## Preconditions

Check these before starting and stop with the reason if one fails.

```
node scripts/refine-dump.mjs --index | tail -1     # prints row count, encryption, directive, legacy_rows
```

- The `sqlite3` CLI is not required; both scripts use `node:sqlite`. Node 22.19 or newer.
- The store may be shared with other running pi sessions. They can append rows while the pass runs.
  Re-read immediately before writing, and treat any id the plan names but the store no longer holds
  as a gate failure rather than a skip.
- An embedding credential must resolve, from `DURABLE_MEMORY_EMBED_KEY` or `apiKey` in the store's
  `config.json`. The scripts fail loudly without one.

## Procedure

### 1. Back up

`refine-apply.mjs` writes its own backup before any write, but take one before reading too, so a
crash mid-pass leaves a known-good copy:

```
mkdir -p ~/.pi/agent/durable-memory/backups
cp ~/.pi/agent/durable-memory/memory.db ~/.pi/agent/durable-memory/backups/memory-<stamp>-manual.db
```

### 2. Read the whole store

```
node scripts/refine-dump.mjs --index      # one line per row: seq, id, first 78 chars
node scripts/refine-dump.mjs              # full text, oldest first
```

Read the full dump. The index alone is not enough to judge a row, and grouping from prefixes produces
groups that look coherent and are not. For a large corpus, dump to a file and read it in chunks under
the read tool's limit; the dump is throwaway, so put it somewhere that does not survive a reboot.

### 3. Measure the starting shape

Record these five numbers. They are the before half of the report, and they are what a later pass
compares against.

- rows
- median and p90 characters per row
- percent of rows carrying `Verify stale by:` or `Stale if`
- percent opening on something other than a path, host, proper name, or code identifier
- percent carrying a quantifier (`every`, `all`, `any`, `never`, `always`) where an enumeration would
  do

### 4. Classify

Group rows by subject, then assign each row one disposition. The antipatterns, in the order they are
worth fixing:

| Antipattern | Recognize it by | Disposition |
| --- | --- | --- |
| Several mechanisms in one row | the row answers more than one question; it runs long; its embedding points at several subjects and surfaces for none | split into one row per question |
| Duplicate or near-duplicate | two rows stating one fact in different words | merge, keep the clearer wording, delete the other |
| Contradiction | two rows asserting incompatible things about one subject | resolve against source; if source cannot settle it, leave both and name the conflict in the report |
| No falsifier | no `Verify stale by:` and no `Stale if` | add the check, or delete the row if no check exists |
| Weak theme | opens on `It`, `This`, `That`, `The same`, or a bare verb | rewrite so a path, host, version, or proper name lands in the first eight words |
| Quantified generic | `every`, `all`, `never`, `always` where the set is finite and known | enumerate the set |
| Session voice or event report | `we`, `today`, `during debugging`, `shipped`, `landed` | restate as a state; keep a date only where the numbers cannot be reproduced later |
| Entailed by a readable file | restates repo content with no commit pin | delete, or pin the commit in the row so the snapshot has a boundary |
| Hedged number | `about`, `roughly`, `approximately`, `may` | measure it, or make the row qualitative |
| Report framing | `Wave-2 report lives at ...; verified facts:` and a semicolon chain behind it | strip the framing, keep the facts, keep the path as a trailing source note |
| Dead one-off | a pending update, a run's ticket counts, an unpushed branch sha, a line count | delete |

The target shape is the four worked examples in `CREATE_EXAMPLES` in `index.ts`, which the
`checkpoint` message prints. One question per row, a rigid designator in the first eight words, a
declarative sentence, then optionally one check sentence opening exactly `Verify stale by:`.

### 5. Write the plan

One JSON file. Three operation kinds:

```json
{
  "replace": [
    {
      "id": "7da1d059",
      "with": [
        "py-spy cannot attach to SGLang inside a Vast.ai container: process_vm_readv returns Permission denied because ptrace is unavailable.",
        "In-process profiling of SGLang inside a Vast.ai container needs a relaunch with SYS_PTRACE, or an nsys capture taken from outside."
      ],
      "allow": []
    }
  ],
  "edit": [{ "id": "0c0bcb9e", "text": "...", "allow": [] }],
  "delete": [{ "id": "0039f760", "why": "one-off: the kata body is in the repo" }]
}
```

`replace` splits or merges one row into one or more rows with new ids, and is the usual operation.
`edit` rewrites a row in place and keeps its id; use it for a wording fix that changes no fact.
`delete` requires a `why`, which is printed in the report and is the only record of the reason.

Each new text must be 80 to 1400 characters. Under 80 is a fragment that cannot stand alone; over
1400 is a wall that surfaces for everything and answers nothing.

### 6. Gate, then apply

```
node scripts/refine-apply.mjs --plan plan.json --dry     # gate only, writes nothing
node scripts/refine-apply.mjs --plan plan.json           # backup, embed, write
```

The gate extracts every path, filename, hex id, `snake_case` name, `camelCase` name, and number from
each source row and requires it to appear in the replacement text, or in that operation's `allow`
list. One unaccounted token fails the whole plan and nothing is written.

Satisfy the gate by restoring the dropped fact, not by widening `allow`. An `allow` entry is for a
token that is a formatting artifact of the extractor and carries no fact: a path prefix the extractor
split off (`/root/logs` from `/root/logs/scheduler.log`), a comma-grouped number it saw as two tokens,
a version string it split (`34.1` from `v0.34.1`). Every `allow` entry the pass adds is a claim that
the token was noise, and the report should carry the count so that claim is visible.

For a large corpus, apply in batches rather than one plan. Each batch backs up, gates, and writes
independently, so a failure partway leaves the earlier batches committed and the store consistent.

### 7. Split anything still over the ceiling

After the pass, check the length distribution again. Any row over 1400 characters goes back through
step 5 as a `replace` with two or more pieces, cut along a real seam rather than by sentence count:
one mechanism per piece, each naming its own subject so it is usable alone.

### 8. Verify and report

```
node scripts/refine-dump.mjs --index | tail -1
```

Confirm `integrity: ok` in the apply output, re-measure the five numbers from step 3, and spot-check
retrieval: pick three questions a future session would ask, and confirm the right row is the top hit.
Retrieval is the thing the pass exists to improve, so a pass that reports only counts has not shown
it worked.

Then clear the mark so the byline stops offering a pass:

```
node scripts/refine-apply.mjs --plan plan.json --clear-legacy
```

`--clear-legacy` may ride along with the final batch. It sets `legacy_rows` to 0 in the store's meta
table. Running a later pass needs no flag; ask for it by name and the agent reads this file.

## What this pass must not do

- Must not delete a row because it looks unimportant. The test is whether a future session could act
  on it, not whether it looks central now.
- Must not summarize. A rewrite that shortens a row by dropping a number, a path, or a condition has
  destroyed the fact; the gate exists to catch exactly that.
- Must not merge rows that answer different questions in order to reduce the row count. Fewer, larger
  rows retrieve worse. That is the failure this pass repairs.
- Must not change a row's `score`. Helpfulness votes are the user's signal, and `refine-apply.mjs`
  carries each source row's score onto its pieces deliberately.
- Must not write to a store opened read-only. A global store is search-only by design.
