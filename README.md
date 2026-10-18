# pi-durable-memory

Encrypted long-term memory for pi, retrieved by embedding similarity, driven by a two-call
loop the model runs on its own.

The model opens a session with `surface` and gets back whatever past sessions decided was
worth carrying forward. It closes each completed task with `finish`, which hands it a fixed
alert telling it to store what it learned and rate what it was shown. Ratings move memories
up and down future rankings. Bodies are AES-256-GCM encrypted in SQLite; their embeddings are
not, because encrypted content cannot be searched.

```
├── index.ts        the extension
├── memory.db       created on first use — the store
├── memory.key      created on first use, mode 0600 — never published
└── bench/          the tuning harness and the functional witness
```

The database rides beside the extension so the directory is self-contained. See **Installing**
for the one case where that needs an override.

## The loop

`durable_memory` takes one `op` plus optional payload arrays:

| op | Purpose |
|---|---|
| `surface` | Embed `query`, return the top-k matching memories decrypted, each with a short id |
| `finish` | No input. Returns the same static closeout alert every time |
| `create` | Store memories. Embeds the cleartext, encrypts the body, discards the cleartext |
| `edit` | Replace a memory's text. Re-embeds and appends this session to its provenance chain |
| `delete` | Remove memories permanently. Cascades to their pointers |
| `pointer` | Attach a caveat or cross-reference, returned with the memory on every future surface |
| `helpful` | Rate memories `true`/`false`, moving them up or down future rankings |

Every mutation array supplied on a call is applied regardless of which `op` names it, in the
order delete → edit → create → pointer → helpful. That is deliberate: a model that attaches a
payload to `finish` still has it stored rather than silently dropped.

`/durable-memory` reports the store size, paths, embedder, credential source, and this
session's call counts.

## Triggers are transcript-checkable, not felt

Both triggers are phrased as checks the model can perform against its own transcript:

- *If you have not yet called `surface` in this conversation, call it before your next tool call.*
- *If you completed a task and have not called `finish` since, call it now.*

This wording is measured, not stylistic. An earlier version said "when you feel sufficiently
oriented" and "when the session is drawing to a close". Across four live pi runs that phrasing
produced `finish` zero times: a model cannot observe a session ending, and a trivial task has no
orientation phase to complete, so both triggers were skipped. Task-completion is observable and
can fire mid-session, so a session that finishes three tasks closes out three times instead of
never. See **Measured behavior** below.

## Provenance

Every write stamps the active pi session id, taken from `ctx.sessionManager.getSessionId()`.
The model never supplies it and cannot. `edit` appends; a repeated session id does not extend
the chain. `surface` reports the newest stamp and how many sessions have touched the memory,
so a contested or frequently-revised memory is visible as one.

## Retrieval

Bodies are encrypted, so search runs over the cleartext embeddings stored beside them. Only the
top-k matched rows are decrypted, which is what keeps a store full of low-scoring silt fast:
silt is never decrypted, only out-ranked. There is no decay, so silt accumulates; `delete` and
negative ratings are the cleanup path.

`emb-qwen3` (1024 dims) via the LunaRoute gateway by default. Ranking is cosine similarity plus
a bounded helpfulness term:

```
rank = cosine + clamp(score * 0.05, -0.25, +0.25)   keep if cosine >= 0.44, take top 8
```

The cap stops a heavily-upvoted memory from ranking on similarity it does not have. Both
constants are measured in `bench/`; **they are embedder-specific** and must be re-derived after
changing models.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DURABLE_MEMORY_EMBED_URL` | `https://gw.lunaroute.com/v1/embeddings` | Any OpenAI-compatible `/embeddings` |
| `DURABLE_MEMORY_EMBED_MODEL` | `emb-qwen3` | Changing this invalidates stored vectors |
| `DURABLE_MEMORY_EMBED_PROVIDER` | `lunaroute` | Which `auth.json` entry to take the credential from |
| `DURABLE_MEMORY_EMBED_KEY` | unset | Explicit credential; skips `auth.json` |
| `DURABLE_MEMORY_DIR` | the extension's own directory | Where `memory.db` and `memory.key` live |

Credential chain, first hit wins: `DURABLE_MEMORY_EMBED_KEY`, then `auth.json[provider].key`,
then `auth.json[provider].access`. The shell-level `LUNAROUTE_API_KEY` is deliberately not
consulted — pi's lunaroute provider authenticates with OAuth, and a stale shell key would be
picked up ahead of the working one. A missing credential raises with setup guidance rather than
falling back.

A changed embedding model does not silently corrupt the store. Vectors of a different dimension
are skipped and counted, and `surface` tells the model to tell you that those memories need
re-embedding or deleting.

## Installing

For a local-path install, nothing to do:

```bash
pi install /path/to/durable-memory
```

**An npm or git install must set `DURABLE_MEMORY_DIR`.** pi reconciles a remote package on
`pi update --extensions`, which can rewrite the package directory and take `memory.db` with it.
Point the store somewhere stable:

```bash
export DURABLE_MEMORY_DIR="$HOME/.pi/agent/durable-memory"
```

`memory.db`, `memory.key`, and the harvested benchmark corpus are excluded from publication, so
a published package ships code only and starts empty.

## Measured behavior

Retrieval, over 35 memories harvested from 35 distinct real past sessions across 29 working
directories, with queries written to share no content words with their target:

| query style | recall@1 | @6 | @8 | MRR |
|---|---|---|---|---|
| three sentences only | 20/35 | 33/35 | 33/35 | 0.710 |
| plus the surrounding work | 30/35 | 34/35 | **35/35** | **0.901** |

Off-topic control queries leaking through the floor: 0 of 12. Reproduce with `bench/run.mjs`;
full numbers and the reasoning behind both constants in `bench/README.md`.

The single largest lever is not a constant — it is asking the model to name the surrounding
subsystem alongside the goal. That instruction lives in the `query` parameter description. If
retrieval regresses, look there first.

Loop reliability, over live `pi --mode json` runs:

| Run | Task shape | surface | finish |
|---|---|---|---|
| 1 | read-only investigation, real repo | action #2 of 5 | none *(felt-state wording)* |
| 2 | write a scratch file | none *(felt-state wording)* | none |
| 3 | write a scratch file | action #1 of 6 | 1, payload split across 2 calls |
| 4 | write a scratch file | action #1 of 5 | 1 bare, then 1 batched `create` |
| 5 | two sequential tasks, one session | action #1 of 9 | **2** — one per completed task |

Runs 1–2 used the felt-state wording. Runs 3–5 use the transcript-checkable wording. Run 4 is
the loop working end to end; run 5 is the mid-session repeat that motivated the redesign. On
routine tasks the model now sends an empty closeout rather than inventing a memory to comply.

n is small and every run used `glm-5.3` at thinking level `low` in `--print` mode. Interactive
sessions were not tested. Treat these as direction, not a rate.

## Verification

```bash
node bench/probe.mjs   # functional witness — exits non-zero on any failure
node bench/run.mjs     # retrieval benchmark and constant sweep
```

`probe.mjs` loads the real extension through jiti and drives it end to end: registration, the
system-prompt injection, ciphertext at rest, session stamping, batching, cascade deletes,
failure paths, keyfile permissions, retrieval accuracy over the harvested corpus, and the
`DURABLE_MEMORY_DIR` override. It copies `index.ts` to a scratch directory and loads it from
there, so the store resolves into the scratch directory and the operator's real `memory.db` is
never touched — no test hook in production code. Nothing about the extension is mocked: real
AES-256-GCM, real `node:sqlite`, real HTTP to the embedding gateway.

## Known limits

- **Silt.** No decay. A memory that stops being relevant keeps its vector and its score; only
  negative ratings and `delete` remove it. Retroactive culling is unimplemented.
- **Embeddings are cleartext.** The vector of a memory is stored unencrypted, so its content is
  recoverable by anyone able to invert 1024 floats. This is inherent to searching encrypted
  content without decrypting all of it.
- **Scan is linear.** `surface` scores every stored memory in JS. Fine to a few thousand rows;
  an ANN index is the next step past that.
- **Single global store.** Memories are not scoped per project, so project-specific ones can
  surface in unrelated work and consume top-k slots. Negative ratings are the mitigation.
