# pi-durable-memory

Long-term memory for [pi](https://github.com/earendil-works/pi-coding-agent), retrieved by
embedding similarity. It stores short notes from past sessions and surfaces the relevant ones
when you start new work.

Memories are stored unencrypted by default; AES-256-GCM encryption is optional. Embeddings
are never encrypted, because encrypted content cannot be searched.

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

Memories live in `memory.db`, outside the package directory, so they survive `pi update`.

## Settings

Run `/durable-memory` with no arguments for an interactive menu. You can configure the
embedding endpoint, model, auth key, and database location. Settings are saved to
`~/.pi/agent/durable-memory/config.json`.

Environment variables override settings when present:

| Variable | Purpose |
|---|---|
| `DURABLE_MEMORY_EMBED_URL` | Embedding endpoint URL |
| `DURABLE_MEMORY_EMBED_MODEL` | Embedding model name |
| `DURABLE_MEMORY_EMBED_KEY` | Auth key |
| `DURABLE_MEMORY_DIR` | Database directory |

## Verification

```bash
node bench/probe.mjs   # functional check
node bench/run.mjs     # retrieval benchmark
```

## Known limits

- No decay: old memories stay until deleted or down-rated.
- Embeddings are stored in cleartext.
- Search scans all memories in memory; fine up to a few thousand.
- Memories are global, not scoped per project.
