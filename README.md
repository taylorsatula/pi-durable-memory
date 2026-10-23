# pi-durable-memory

Long-term memory for [pi](https://github.com/earendil-works/pi-coding-agent), retrieved by
embedding similarity. It stores short notes from past sessions and surfaces the relevant ones
when you start new work.

Memories are stored unencrypted by default; AES-256-GCM encryption is one menu choice away.
Embeddings are never encrypted, because encrypted content cannot be searched.

## Install

```bash
pi install npm:@taylorsatula/pi-durable-memory
```

No configuration. The store is created on first use in `~/.pi/agent/durable-memory/`, which
follows `PI_CODING_AGENT_DIR` if you have set it.

## How it works

The extension adds one tool, `durable_memory`, and one command, `/durable-memory`.

- `surface` looks up memories related to a query and returns the best matches.
- `checkpoint` returns a reminder to store what you learned and rate what you saw.
- `create`, `edit`, `delete` manage memories.
- `helpful` rates memories so more useful ones rank higher.
- `ledger` takes file paths relative to the working directory and returns the one-line notes
  earlier sessions left on each file.
- `annotate` appends those notes: at each checkpoint the model writes one short sentence per file
  it edited or wrote ("fixed the off-by-one introduced in a3f9c21"). Notes are keyed by repository
  (its root commit) and path, never embedded, and appear only when `ledger` asks for the file.

Memories live in `memory.db`, outside the package directory, so they survive `pi update`.

## Settings

Run `/durable-memory` with no arguments for an interactive menu. You can configure the
embedding endpoint, model, auth key, database location, and whether the local store is
encrypted. Settings are saved to `~/.pi/agent/durable-memory/config.json`. `/durable-memory
status` prints the same information without a menu.

Environment variables override settings when present:

| Variable | Purpose |
|---|---|
| `DURABLE_MEMORY_EMBED_URL` | Embedding endpoint URL |
| `DURABLE_MEMORY_EMBED_MODEL` | Embedding model name |
| `DURABLE_MEMORY_EMBED_KEY` | Auth key |
| `DURABLE_MEMORY_DIR` | Database directory |
| `DURABLE_MEMORY_GLOBAL_DIR` | Read-only shared store, merged into `surface` |

## Shared stores

A second, read-only store can be mounted next to your own — a team corpus everyone searches
while each person still writes privately to their local store. Mounting one, seeding it, and
what happens when its vectors were built with a different embedding model are covered in
[docs/global-store.md](docs/global-store.md).

## Verification

The probe and the retrieval benchmark live in the repository, not in the published package:

```bash
git clone https://github.com/taylorsatula/pi-durable-memory
cd pi-durable-memory
node bench/probe.mjs   # functional witness: every code path, end to end
node bench/run.mjs     # retrieval benchmark behind the cosine floor and K
```

Both need an embedding credential (`DURABLE_MEMORY_EMBED_KEY`, the `apiKey` in
`~/.pi/agent/durable-memory/config.json`, or a `lunaroute` entry in `~/.pi/agent/auth.json`)
and run against a scratch store, never your own. `npm publish` runs the probe first.

## Known limits

- No decay: old memories stay until deleted or down-rated.
- Embeddings and ledger file paths are stored in cleartext; note text follows the encryption setting.
- The ledger is keyed by path, so a renamed file starts a fresh ledger.
- Search scans all memories in memory; fine up to a few thousand.
- Memories are global, not scoped per project.
- A shared store is read-only: it can be searched, never written or re-embedded from here.
