# HTTPSticky

**[Source](https://github.com/kirtimukh/HTTPSticky)**

A one page app that uses WebSocket connections to show **sticky sessions** in action.

Modern webapps are scalable, in some part, due to http connections being stateless. But **sticky sessions are still required** for tools that require **state to be maintained in-memory**; for eg.

- **Streaming or downloading a large file in chunks**: Server has to remember how much has already been delivered
- **Canary deployments**: When experimental features are rolled out to few users only
- **Per user AI model**: Need not load different AI models in same container for each new request

## A bit about WebSocket connections

**HTTP connections are ephemeral** whereas **WebSocket connections are long lived**.
- **Once the request response cycle is over the server ends the connection with the client**. This is what allows applications to scale so well. You can run multiple instances of the same application code and the app will do its job regardless of which instance receives your http request.
- **WebSocket** connections are meant to **maintain connection for extended duration**. That's why when **Client_A** connects with **Server_1** the connection is **kept alive in-memory** of **Server_1**.
- If **Server_10** receives an event that requires it to send the data to **Client_A**
  - it has to publish it to a **Redis-like pub/sub system**.
  - Similarly, it subscribes to the same **channel** for messages to clients whose WS connection it has in memory.

```text
                    live WebSocket tunnel
         ┌──────────────────────────────────────┐
         │                                      │
         ▼                                      ▼
┌──────────────┐   HTTP    ┌───────┐         ┌───────┐         ┌───────┐
│ Your browser │──────────▶│ Nginx │────────▶│ app-1 │◀───────▶│ Redis │
└──────────────┘           └───────┘    ┌───▶│       │  pub/   │ pub/  │
                                        │    └───────┘  sub    │ sub   │
                                        │    ┌───────┐         └───┬───┘
                                        ├───▶│ app-2 │◀────────────┤
                                        │    └───────┘             │
                                        │    ┌───────┐             │
                                        └───▶│ app-3 │◀────────────┘
                                             └───────┘

  • WS lives on one instance (e.g. app-1). Only that instance can push over the tunnel.
  • Other instances publish to Redis; the WS-home instance consumes and delivers.
```

## The App

### Setup:
1. [Install docker](https://docs.docker.com/desktop/)
2. `cd HTTPSticky`
3. `docker compose up`

### Live version — 3 containers, one uvicorn process each

```text
  Your browser ──▶ Nginx ──▶ app-1 / app-2 / app-3 ──▶ Redis
                     │              ▲
                     │              │
                     └──── sticky cookie / round-robin ────┘
                     └──── live WebSocket tunnel (one home) ─┘
```

Buttons (same labels as the app UI):

1. **HTTP RR** — Requests are delivered to application containers **in round-robin** fashion (no sticky cookie).
2. **HTTP Sticky** — Sticky cookie (`StickyStr`): Nginx **hashes the cookie value** and routes to the **same upstream every time**. This **includes** the **initial WS connection** (and reconnects, which restore the cookie first). Same cookie value → same hash bucket — **not** necessarily the instance that *issued* the cookie (`-by-{APP_ID}` is for display only).
3. **WS Only** — WS connections are long lived. The **same container receives** all messages sent through that connection. If the connection is broken, the client **restores the same cookie** and reconnects to the **same hash target**.
4. **Redis Pub/Sub** — Standard pattern for managing WS fan-out. **Messages are published on a Redis channel**; every instance receives them, and the container that holds the recipient's connection delivers over WS.
5. **HTTP→WS** — WS response **not guaranteed**. **No sticky cookie** on the HTTP request. The instance that has the client's WebSocket session may not receive it.
6. **Sticky→WS** — Uses **sticky cookie** on the HTTP request. If the **WebSocket was opened with the same cookie**, the instance that receives the request is the WS home (same hash → same upstream).

## Code implementation

### Dependencies

Redis, FastAPI, Uvicorn, Docker, Nginx

### FastAPI and Docker

[docker-compose.yml](https://github.com/kirtimukh/HTTPSticky/blob/main/docker-compose.yml)

- **3 replica containers** of the app are run
- Each container runs **one uvicorn process** (default single worker; compose uses `--reload`)
- Nginx handles the traffic to each of these containers

> **Note:** Comment out `app1`/`app2`/`app3` (and nginx) and enable the commented `app` service in `docker-compose.yml` — one container with **4 uvicorn workers**. Sticky will not work and WS delivery is not guaranteed for Sticky→WS / HTTP→WS paths: sticky routing is done by **Nginx between containers**, not between workers inside the same service. Redis pub/sub still delivers, which is why that path remains reliable.

### Nginx

See [nginx.conf](https://github.com/kirtimukh/HTTPSticky/blob/main/nginx.conf)

- **Load balancing** via `hash $cookie_StickyStr consistent` — same cookie value always maps to the same upstream.
- For cases (like first page load) where the sticky cookie is missing **round-robin is used as fallback**.
- **Without this fallback** all requests without the cookie will be routed to the same container (empty string hashes to one fixed peer).
- Hashing is **not** issuer affinity: a cookie set by `app-1` may land on `app-2` or `app-3`. Sticky→WS still works because the **WS upgrade used the same cookie**, so HTTP and WS share one hash target.

### App flow - initial page load

See [sample logs](https://github.com/kirtimukh/HTTPSticky/blob/main/records.log)

- Browser requests `index.html` (no cookie yet → round robin).
- FastAPI sets custom `StickyStr` cookie and returns `HTMLResponse`.
- Browser receives the html page. The `StickyStr` is also saved in session JS.
- **WebSocket connection is made** with that cookie; Nginx hashes it to a fixed upstream (the WS home). That may differ from the instance that set the cookie.
- After connection, the **cookie is removed** from `document` *to simulate non-sticky behaviour*. On reconnect, JS **restores `StickyStr`** before opening WS so the hash target (WS home) stays stable.
<br>

- Buttons that mention 'sticky' **add the saved StickyStr** to `document.cookie` before making the request.
- All other http requests are made **without StickyStr** and are round-robined by nginx.
- This is for demonstration only.

```text
┌──────────────┐  http (dashed)   ┌────────────────────────────┐
│ Your browser │─────────────────▶│ Nginx                      │
│              │                  │ hash StickyStr → same app  │
│              │  ws conn (solid) │ empty cookie → round robin │
│              │═════════════════▶│                            │
└──────────────┘                  └─────────────┬──────────────┘
                                                │ http
                         ┌──────────────────────┼──────────────────────┐
                         ▼                      ▼                      ▼
                   ┌───────────┐          ┌───────────┐          ┌───────────┐
                   │   app-1   │          │   app-2   │          │   app-3   │
                   │ WS lives  │          │ cannot    │          │ cannot    │
                   │   here    │          │ push WS   │          │ push WS   │
                   └─────┬─────┘          └─────┬─────┘          └─────┬─────┘
                         │                      │                      │
                         └──────────┬───────────┴──────────┬───────────┘
                                    ▼                      ▼
                              ┌──────────────────────────────────┐
                              │         Redis  ·  pub/sub        │
                              └──────────────────────────────────┘
```
