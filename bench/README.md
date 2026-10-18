# bench/ — retrieval tuning harness

The witness for two numbers in `../index.ts`: `MIN_COSINE = 0.44` and `TOP_K = 8`. Those are
measurements, not guesses, and this directory is how they get re-measured.

## Files

| File | Purpose |
|---|---|
| `probe.mjs` | Functional witness. Loads the real extension through jiti, drives `durable_memory` end to end — encryption at rest, session stamping, batching, failure paths, retrieval accuracy — against a scratch copy so the operator's `memory.db` is never touched. |
| `run.mjs` | Retrieval benchmark. Embeds a corpus once (cached), then sweeps the cosine floor and K, reporting recall, MRR, off-topic leakage, and the maximum-margin floor. |
| `digest.mjs` | Compresses one pi session JSONL into a readable transcript, for harvesting a corpus. |
| `neg.json` | Twelve off-topic control queries. Nothing in the corpus relates to them; a floor that lets one through is too low. |
| `corpus.json` | Harvested memories. **Not published** — it is derived from the operator's own session history. |
| `embcache.json` | Cached embeddings keyed by text, so re-running `run.mjs` costs nothing. **Not published.** |

## Running

```bash
node bench/probe.mjs     # functional witness; exits non-zero on any failure
node bench/run.mjs       # tuning sweep; add --no-cache to re-embed from scratch
```

Both need the `lunaroute` credential in `~/.pi/agent/auth.json`, or
`DURABLE_MEMORY_EMBED_KEY`. `probe.mjs` also needs `PI_NODE_MODULES` if it cannot find a pi
install under `~/.pi/agent/install/releases`.

`probe.mjs` skips its retrieval section with a visible failure if `corpus.json` is absent, so
a fresh clone still exercises everything else.

## Building a corpus

`run.mjs` and the retrieval half of `probe.mjs` read `corpus.json`:

```json
{ "memories": [ {
    "id": "m01",
    "memory":  "one self-contained sentence, as the tool would store it",
    "category": "constraint | tooling | fix_that_worked | architecture_fact | project_convention | user_preference",
    "query":    "exactly three sentences: the task, the constraint, what good looks like",
    "synopsis": "two or three sentences describing the surrounding code and subsystem",
    "shared_content_words": ["content words appearing in BOTH memory and query"],
    "cwd": "/abs/path", "session_id": "uuid", "session_file": "/abs/path.jsonl",
    "evidence": "verbatim quote from the transcript that grounds the memory"
} ] }
```

Harvest with `digest.mjs` over a spread of real sessions:

```bash
node bench/digest.mjs ~/.pi/agent/sessions/<project>/<file>.jsonl 60000
```

Two properties make the corpus worth anything:

**The query must not contain the memory's distinctive words.** If it does, retrieval succeeds
by keyword overlap and the numbers say nothing about whether the embedder understands
anything — a bag-of-words hasher would score the same. Write each query the way a model would
at the *start* of a session, before the memory existed. `shared_content_words` records the
overlap so it can be checked mechanically; aim for zero or one.

**`query` and `synopsis` are stored separately on purpose.** `run.mjs` scores them apart
(`terse`) and concatenated (`rich`), because that difference is the single largest lever on
accuracy and it is controlled by the tool's parameter description, not by any constant.

Reject: session narration, anything ungrounded in a quote, secrets, and anything recoverable
by reading one file in the repository.

## Measured, 2026-10-17

`emb-qwen3` (1024 dims), 35 memories harvested from 35 distinct real sessions across 29
working directories, 12 off-topic controls.

```
rich-query true match   min 0.4766  median 0.6157
terse-query true match  min 0.3867  median 0.5197
off-topic best match    max 0.4083  p90   0.3903
maximum-margin floor    0.4425
```

| query style | recall@1 | @3 | @6 | @8 | MRR |
|---|---|---|---|---|---|
| terse — three sentences only | 20/35 | 28/35 | 33/35 | 33/35 | 0.710 |
| rich — plus the surrounding work | 30/35 | 32/35 | 34/35 | **35/35** | **0.901** |

Off-topic controls leaking through the floor: **0 of 12** at any floor from 0.41 up.

Three conclusions drove the shipped values:

**The floor is an off-topic rejector, not a precision knob.** Recall is flat from 0.30 to 0.49
for both query styles. Below 0.41 off-topic queries start returning memories; above 0.44 terse
queries start losing true matches. 0.44 is the midpoint of the widest gap, clearing the worst
off-topic by 0.032 and the weakest rich true match by 0.037.

**K=8 is the knee.** Rich recall reaches 35/35 at 8 and never improves; the floor already
limits a typical query to ~4.5 memories, so slots beyond 8 are dead weight.

**Asking the model to name the surrounding work is worth more than any ranking change.** That
one instruction is the difference between MRR 0.710 and 0.901, and it lives in the `query`
parameter description. If retrieval ever regresses, look there before touching a constant.

Rejected on measurement: hubness correction (subtracting each memory's mean similarity to all
others). Worth +0.11 MRR on terse queries but only +0.003 once the distill names the
surrounding work, at a cost of O(n² · dim) per query.

**These numbers are embedder-specific.** Re-run `run.mjs` after changing
`DURABLE_MEMORY_EMBED_MODEL`; a different model has a different similarity distribution and
0.44 will be wrong for it.
