# Global (shared) memory stores

pi-durable-memory can search an additional SQLite database, the **global** store, alongside the
user's **local** store. This lets a team share a corpus of memories that every member draws on,
while each member still writes privately to their own local store.

## How it works

- Two stores: `local` (always present, writable) and `global` (optional, **read-only**).
- `surface` searches both and merges the hits into one ranking, ordered by the same key a single
  store uses. When both stores contribute, each memory is labelled `[local]` or `[global]`; with
  one store there is no label.
- `create`, `edit`, `delete`, and `helpful` always target `local`. A write aimed at the global
  store throws rather than being silently dropped.
- Searching never writes to the global store: no schema migration, no re-embedding, no golden
  vector. A corpus embedded with a different model than the one you have configured cannot be
  compared against your queries, so it is skipped with the reason printed in the result — and the
  local store's matches still come back.

## Configuration

Set the global store location, either in `~/.pi/agent/durable-memory/config.json`:

```json
{ "globalStoreDir": "/shared/pi-durable-memory" }
```

or through the environment:

```sh
export DURABLE_MEMORY_GLOBAL_DIR=/shared/pi-durable-memory
```

The environment wins over the file. Only `local` is created for you: the global directory must
already exist and contain a `memory.db` (and a `memory.key`, if that corpus is encrypted). Point
it at a directory with no database and the tool says so instead of creating one.

There is deliberately no `/durable-memory` menu row for it — mounting a shared corpus is a
deployment decision, not a per-session preference. `/durable-memory status` reports the store that
is mounted and how many memories it holds.

## Seeding a global corpus

Run the standalone seeder on the machine that owns the corpus:

```sh
node scripts/seed-global.mjs --dir /shared/pi-durable-memory --file corpus.txt
```

Each non-empty line of `corpus.txt` becomes one memory. The seeder embeds them with the endpoint
and model you give it and records that model in the database, which is what lets a client tell
whether the corpus is comparable with its own configuration. Seed with the same
`DURABLE_MEMORY_EMBED_MODEL` your users have configured, or the store will be skipped for them.

The seeder writes bodies in the clear. Distributing an encrypted corpus means shipping a
`memory.key` alongside it out of band; the extension reads whichever mode the store's own metadata
declares.

## Encryption

A global store's mode is its own: `/durable-memory` switches encryption for the local store only,
and never for a mounted global store. Embeddings are stored in the clear in both stores — encrypted
content cannot be searched — so a shared corpus leaks topic vectors even when its bodies are
encrypted. Treat that as the deployment decision it is.
