# FUNK listen demo (SvelteKit)

A **minimal contract-reference demo**, not a product. It exercises the current
FUNK contract against the running local stack across one thin slice:
**credential auth + now-playing + anonymous HLS**. A SvelteKit server route
(`src/routes/api/now-playing/+server.ts`) holds `FUNK_SERVICE_TOKEN`
server-side and proxies `GET $FUNK_RADIO_URL/v1/radio/now-playing`; the token
never reaches the browser. The page plays the public, anonymous
`PUBLIC_FUNK_HLS_URL` with `hls.js` and polls the proxy every ~10s, showing
the now-playing `source` and `title`. Per [ADR-003](../../docs/adr/ADR-003-funk-consumer-boundary.md)
the *real* consumer lives in its own repo, not here — so there is a deliberate
tension in keeping consumer code in the FUNK tree. This directory survives only
as a living, runnable example of the contract, kept honest by running against
the local stack; treat it as documentation that compiles, not as the consumer.

## Run

```bash
cd demo/svelte-poc
cp .env.example .env        # then mint + paste a FUNK_SERVICE_TOKEN (see below)
bun install
bun run dev                 # http://localhost:7270
```

Mint the service token (one curl against FUNK's auth bootstrap):

```bash
curl -s -X POST http://localhost:7401/v1/credentials \
  -H "authorization: Bearer dev_admin_bootstrap_change_me" \
  -H "content-type: application/json" \
  -d '{"label":"demo-poc"}'
# → copy the returned "token" into FUNK_SERVICE_TOKEN in .env
```

## Env

| Var | Scope | Purpose |
|---|---|---|
| `FUNK_RADIO_URL` | server | Radio control-plane base (`http://localhost:7403`). |
| `FUNK_SERVICE_TOKEN` | server | Bearer for control-plane calls. **Never shipped to the browser.** |
| `PUBLIC_FUNK_HLS_URL` | client | Anonymous HLS master playlist hls.js hits directly. |

## Verify the token stays server-side

The proxy is the only thing that sees `FUNK_SERVICE_TOKEN`. To confirm it never
leaks into client code:

```bash
bun run build
grep -r "$(grep FUNK_SERVICE_TOKEN .env | cut -d= -f2)" .svelte-kit/output/client || echo "token absent from client bundle ✓"
```
