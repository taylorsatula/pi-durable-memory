# pi-durable-memory

Encrypted long-term memory for pi, retrieved by embedding similarity, driven by a two-call
loop the model runs on its own.

The model opens a session with `surface` and gets back whatever past sessions decided was
worth carrying forward, and surfaces again as the work moves to new ground. It records each
completed task with `checkpoint`, which hands it a fixed alert telling it to store what it
learned and rate what it was shown. Ratings move memories up and down future rankings.
Bodies are AES-256-GCM encrypted in SQLite; their embeddings are not, because encrypted
content cannot be searched.

```
├── index.ts        the extension
└── bench/          the tuning harness and the functional witness
```

The store is not in the package. `memory.db` and `memory.key` are created on first use in
`~/.pi/agent/durable-memory/`, outside every directory pi reconciles, so they survive
`pi update`. See **Where the store lives** for why that matters.

## The loop

`durable_memory` takes one `op` plus optional payload arrays:

| op | Purpose |
|---|---|
| `surface` | Embed `query`, return the top-k matching memories decrypted, each with a short id |
| `checkpoint` | No input. Returns the same static checkpoint alert every time |
| `create` | Store memories. Embeds the cleartext, encrypts the body, discards the cleartext |
| `edit` | Replace a memory's text. Re-embeds and appends this session to its provenance chain |
| `delete` | Remove memories permanently. Cascades to their pointers |
| `pointer` | Attach a caveat or cross-reference, returned with the memory on every future surface |
| `helpful` | Rate memories `true`/`false`, moving them up or down future rankings |

Every mutation array supplied on a call is applied regardless of which `op` names it, in the
order delete → edit → create → pointer → helpful. That is deliberate: a model that attaches a
payload to `checkpoint` still has it stored rather than silently dropped. A mutation op that
applies nothing throws rather than returning a no-op report. Ids are the full ids `surface`
returned — an unknown id is an error.

`/durable-memory status` reports the store size, paths, endpoint, credential source, and this
session's call counts; the bare command opens the settings menu.

## Triggers are transcript-checkable, not felt

Both triggers are phrased as checks the model can perform against its own transcript:

- *If you have not yet called `surface` in this conversation, call it before your first state-changing action.*
- *If you completed a task or just committed and have not called `checkpoint` since, call it now.*

This wording is measured, not stylistic. An earlier version said "when you feel sufficiently
oriented" and "when the session is drawing to a close". Across four live pi runs that phrasing
produced `checkpoint` zero times: a model cannot observe a session ending, and a trivial task has no
orientation phase to complete, so both triggers were skipped. Task-completion is observable and
can fire mid-session, so a session that completes three tasks checkpoints three times instead of
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

## Settings

Run `/durable-memory` with no arguments for an interactive menu:

```
Endpoint        remote — https://gw.lunaroute.com/v1/embeddings
URL             https://gw.lunaroute.com/v1/embeddings
Embedding model emb-qwen3
Auth key        set (…a1b2, 40 chars)
Database dir    /Users/you/.pi/agent/durable-memory
Show status
Done
```

- **Endpoint** — `remote` for a hosted OpenAI-compatible endpoint
  (`https://gw.lunaroute.com/v1/embeddings`), `local` for a llama.cpp, Ollama or LM Studio
  server on this machine (`http://localhost:8080/v1/embeddings`). The preset carries its URL.
- **URL** — the endpoint's address, editable for non-default gateways; blank restores the
  endpoint's preset.
- **Embedding model** — the model name sent to that endpoint.
- **Auth key** — bearer token, stored in the settings file at mode 0600. Blank clears it. The
  dialog is not masked, so the token is visible while you type it.
- **Database dir** — where `memory.db` and `memory.key` live. A path inside `node_modules` is
  refused, because an update would delete it.

Every change is written to disk immediately. Endpoint, URL, model, and key take effect on the
next tool call with no restart; a database-dir change needs pi reopened, and the menu says so.
A local endpoint does not require a key: if none is configured, the request is sent
without an `Authorization` header.

Settings live at `~/.pi/agent/durable-memory/config.json`, mode 0600, at a fixed path so moving
the database does not move the settings. A missing file is prefilled with the defaults on first
read. `/durable-memory status` prints the resolved state without opening the menu.

### Environment variables

Env vars win over the settings file, which wins over the defaults. They exist for CI and one-off
runs; the settings command is the normal path.

| Variable | Overrides | Purpose |
|---|---|---|
| `DURABLE_MEMORY_EMBED_URL` | endpoint URL | Any OpenAI-compatible `/embeddings` |
| `DURABLE_MEMORY_EMBED_MODEL` | model | Changing this triggers regeneration of stored vectors |
| `DURABLE_MEMORY_EMBED_KEY` | auth key | Explicit credential; skips the settings file |
| `DURABLE_MEMORY_DIR` | database dir | Where `memory.db` and `memory.key` live. Refused inside `node_modules`. |

The credential chain, first hit wins: `DURABLE_MEMORY_EMBED_KEY`, then the settings file's
`apiKey`. For a `local` endpoint an empty chain is fine and the header is omitted; for `remote`
a missing credential raises with setup guidance rather than falling back.

A changed embedding model does not silently corrupt the store. Every vector is tagged with the
model name that wrote it; when the configured model differs, the next `surface` or `create`
regenerates every embedding from its decrypted body in one batch. Vectors vary slightly across
runs of the same model, so the model name — never vector comparison — is the trigger.

## Installing

```bash
pi install npm:@taylorsatula/pi-durable-memory
```

No configuration. The store is created on first use in `~/.pi/agent/durable-memory/`, which
follows `PI_CODING_AGENT_DIR` if you have set it.

`memory.db`, `memory.key`, and the harvested benchmark corpus are excluded from publication, so
the package ships code only and every install starts empty.

### Where the store lives, and why

The store is deliberately kept outside the package directory. `pi update --extensions` replaces
an npm package wholesale: a version bump re-extracts the tarball over the old directory. A store
kept beside `index.ts` is therefore deleted on the first update.

That is measured, not assumed. Upgrading a scratch install from `0.1.0` to `0.1.1` deleted both
`memory.db` and `memory.key`. A git-source install is worse — pi runs `git clean -fdx`, whose
`-x` removes gitignored files, which is exactly what the store and key are. A same-version
reinstall is a no-op and preserves them, which is why the loss is easy to miss: it only happens
when the version actually changes.

So the default sits in pi's config directory, and an override pointing inside `node_modules`
is refused at load with an error naming the problem rather than failing silently later.

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
retrieval regresses, look there first. The floor was also derived from two-part distills; the
prompts since relaxed the query shape to one to three sentences, so treat the plus-row as the
shaped-query ceiling, not a guarantee for bare one-sentence queries.

Loop reliability, over live `pi --mode json` runs:

| Run | Task shape | surface | checkpoint |
|---|---|---|---|
| 1 | read-only investigation, real repo | action #2 of 5 | none *(felt-state wording)* |
| 2 | write a scratch file | none *(felt-state wording)* | none |
| 3 | write a scratch file | action #1 of 6 | 1, payload split across 2 calls |
| 4 | write a scratch file | action #1 of 5 | 1 bare, then 1 batched `create` |
| 5 | two sequential tasks, one session | action #1 of 9 | **2** — one per completed task |

Runs 1–2 used the felt-state wording. Runs 3–5 use the transcript-checkable wording. Run 4 is
the loop working end to end; run 5 is the mid-session repeat that motivated the redesign. On
routine tasks the model now sends an empty checkpoint rather than inventing a memory to comply.

n is small and every run used `glm-5.3` at thinking level `low` in `--print` mode. Interactive
sessions were not tested. Treat these as direction, not a rate.

## Verification

```bash
node bench/probe.mjs   # functional witness — exits non-zero on any failure
node bench/run.mjs     # retrieval benchmark and constant sweep
```

`probe.mjs` loads the real extension through jiti and drives it end to end: registration, the
system-prompt injection, ciphertext at rest, session stamping, batching, cascade deletes,
failure paths, keyfile permissions, retrieval accuracy over the harvested corpus, the store
location and its `node_modules` refusal. It points `DURABLE_MEMORY_DIR` at a scratch path before
loading, so the operator's real `memory.db` is never touched — no test hook in production code.
Nothing about the extension is mocked: real AES-256-GCM, real `node:sqlite`, real HTTP to the
embedding gateway.

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
