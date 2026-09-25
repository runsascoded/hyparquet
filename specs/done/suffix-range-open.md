# Spec: open a URL of unknown size with one suffix-range GET

Status: **done** (2026-09-25). Supersedes the `optional-byteLength` branch (2024-02, v0.2.3), which made `AsyncBuffer.byteLength` optional and read footers with suffix ranges; its code predates most of the current reader.

## Problem

`asyncBufferFromUrl({ url })` without a `byteLength` spends a round trip on a HEAD (or a `bytes=0-0` GET fallback) just to learn the file size, and then `parquetMetadataAsync` makes a second request for the footer. Callers that know the size out of band already skip the HEAD by passing `byteLength`; this is for callers that don't.

## Proposal

Opt-in `suffixFetchSize?: number` on `asyncBufferFromUrl`. When `byteLength` is not given, send one `GET` with `Range: bytes=-<suffixFetchSize>`:

- **206 with a readable `Content-Range: bytes a-b/<total>`**: `byteLength = total`; keep the returned tail. Later `slice`s that fall inside the tail are served from memory, so `parquetMetadataAsync` (default `initialFetchSize` 512 KB) needs no further request when `suffixFetchSize >= initialFetchSize` and the footer fits. A file smaller than `suffixFetchSize` comes back whole (`bytes 0-(n-1)/n`), so every read is served from memory.
- **200** (server ignored `Range`): the body is the whole file; `byteLength` is its length, and the existing whole-buffer fallback serves all slices.
- **Anything else** (non-2xx, 206 without a readable `Content-Range`): cancel the body and fall back to the existing HEAD path.

Verified against `data.ctbk.dev`: `Range: bytes=-524288` on a 1,565,232-byte shard returns `206`, `Content-Range: bytes 1040944-1565231/1565232`, and a body ending in `PAR1`.

## Why opt-in

Server-side (Node, CFW `fetch` of a public URL) this is a pure win: two round trips become one. In browsers, cross-origin:

- A suffix range is not a CORS-safelisted `Range` form, so the request is preflighted (cacheable via `Access-Control-Max-Age`).
- JS can only read `Content-Range` if the server lists it in `Access-Control-Expose-Headers`. ctbk's R2 CORS currently exposes `Accept-Ranges, Content-Encoding, Content-Length, ETag`, not `Content-Range`, so there it would fall back to HEAD after a wasted GET.

## As built

- `asyncBufferFromUrl({ url, suffixFetchSize })` in `src/utils.js`, with a private `fetchSuffix` helper. The tail stays in memory for the buffer's lifetime; slices fully inside it never hit the network, others use the usual ranged GETs.
- Tests: `test/utils.test.js` "with suffixFetchSize" (the six cases below). README: `asyncBufferFromUrl` section.
- Live on `data.ctbk.dev` (`avail/agg/h1/2026-09-20.parquet`): `asyncBufferFromUrl` + `parquetMetadataAsync` made 2 requests (`HEAD`, `GET bytes=1040944-1565231`) without the option, 1 (`GET bytes=-524288`) with `suffixFetchSize: 512 * 1024`; same `byteLength` and 211 row groups.

## Non-goals

- R2 bindings (ctbk `gbfs/cascade`'s `r2SlicedBuffer`) aren't HTTP; the same trick there is `r2.get(key, { range: { suffix: N } })`, whose result carries `size`. Caller-side.
- Making `AsyncBuffer.byteLength` optional.

## Acceptance

- Tests (mocked `fetch`): 206 path sets `byteLength` and serves an in-tail slice without another fetch; out-of-tail slices use normal ranged GETs; small file whole-in-tail; 200 path; missing `Content-Range` falls back to HEAD; given `byteLength` skips the suffix GET.
- README note under `asyncBufferFromUrl`, including the CORS requirements.
- Delete the `optional-byteLength` branch on `r`.
