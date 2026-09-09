# Host Nginx Setup — PanasaHRM

Add the following to the host nginx config at `ai.arttechgroup.com:7777`.

PanasaHRM's slot on the host is **`127.0.0.1:4788`** (`HRM_PUBLISH_PORT` in
`infrastructure/compose/prod.env`). Only the stack's edge nginx publishes a port, and only to
loopback; PostgreSQL, MinIO and Redis are reachable on the compose network and nowhere else.

Confirm the port is free before you start — it must print nothing:

```bash
ss -ltnp | grep 4788
```

## 1. Upstream (add with the other upstream blocks)

```nginx
upstream panasa_hrm_app {
    server 127.0.0.1:4788;
}
```

## 2. Trailing-slash redirect (add with the other redirect blocks)

```nginx
location = /panasa-hrm {
    return 301 /panasa-hrm/;
}
```

## 3. Pass-through location (add with the other location blocks)

```nginx
# ==================== PANASA HRM ====================
location /panasa-hrm/ {
    proxy_pass http://panasa_hrm_app;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 26m;    # 25 MiB document cap plus the multipart envelope
    proxy_read_timeout   120s;   # document bytes stream through the API (DEC-046)
    proxy_send_timeout   120s;
    proxy_buffering off;         # do not re-buffer a 25 MiB download at this hop
}
```

No rewrite — the full `/panasa-hrm/` path is passed to the container. Next.js is **built** with
`basePath=/panasa-hrm` and already serves every route and asset under that prefix, so stripping
it here would 404 the whole app. The container's edge nginx splits `/panasa-hrm/api/` (NestJS,
`api:4000`) from everything else (Next.js, `web:3100`) internally.

### Deliberate differences from the KYC/KYB block

| Setting | There | Here | Why |
|---|---|---|---|
| Body cap | `50M` | `26m` | The document cap is 25 MiB, enforced in `apps/api/src/documents.ts`. Refusing at the front door means an oversized body never reaches Node |
| Read timeout | `300s` | `120s` | Matches the edge nginx's `/api/` timeout. A longer outer timeout only holds a worker on a request the inner hop has already given up on |
| `Upgrade` / `Connection 'upgrade'` | set | **omitted** | PanasaHRM opens no websocket in production. Setting `Connection: 'upgrade'` unconditionally sends it on ordinary requests too, which breaks upstream keepalive; if a websocket is ever added, do it with an `http`-level `map $http_upgrade $connection_upgrade` rather than a literal |
| `proxy_cache_bypass` | set | omitted | No `proxy_cache` is configured on this path, so it is a no-op |
| `proxy_buffering` | default (on) | `off` | The edge already streams `/api/` unbuffered; leaving the host hop buffering spools each document to disk before the browser sees a byte |

## 4. Test and reload

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Only reload if `nginx -t` reports success.

## 5. Verify through the front door

Three checks, not one — "the port answers" has hidden a broken app before:

```bash
BASE=https://ai.arttechgroup.com:7777/panasa-hrm
curl -s -o /dev/null -w '%{http_code}\n' $BASE/healthz        # 200 — edge nginx is up
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/auth/me    # 401 — API is up and routing
curl -s -o /dev/null -w '%{http_code}\n' $BASE/login          # 200 — web app renders
```

`401` is the success condition for the API on purpose: there is no unauthenticated health route,
and an authentication refusal is a perfectly good liveness signal. A `502` means the API is down;
a `500` means it is up and broken.

## The prefix has to match in three places, and two are baked into images

| Where | How it gets there | Symptom if it disagrees |
|---|---|---|
| The web image | `NEXT_PUBLIC_BASE_PATH` build arg | HTML loads, every asset 404s |
| The edge nginx | `HRM_BASE_PATH` → envsubst over `nginx.conf.template` | **Silent.** The API location stops matching, so `/api/` falls through to Next, which proxies it onward — the app still works, with a Node hop in front of every document stream |
| The host nginx | the `location` block above | 404 at the front door |

Compose drives all three from the single `NEXT_PUBLIC_BASE_PATH` value in `prod.env`, so they
cannot drift as long as you change it there **and rebuild** (`./deploy.sh` does). Likewise, if
4788 is taken, change `HRM_PUBLISH_PORT` in `prod.env` *and* the upstream in step 1 — they must
agree.

To serve at the root instead (a dedicated hostname or `server {}` block), set
`NEXT_PUBLIC_BASE_PATH=` empty and rebuild.

## Two things this block cannot do, and someone must

1. **HSTS.** The stack sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
   `Permissions-Policy` itself, but HSTS is a property of the TLS origin and belongs on this host
   nginx. On the plain-HTTP hop it would be a no-op.
2. **`HRM_SECURE_COOKIES=true` requires real https end to end.** It drives both the session
   cookie's `Secure` flag and its `__Host-` prefix (ADR-0010). Reaching the app over plain HTTP
   fails at login rather than downgrading quietly — that is intended.

Full deployment procedure, secrets and known gaps: [`DEPLOY.md`](./DEPLOY.md).
