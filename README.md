# HTTPSticky

**[Source](https://github.com/kirtimukh/HTTPSticky)**

A one page app that uses WebSocket connections to show **sticky sessions** in action.

Modern webapps are scalable, in some part, due to http connections being stateless. But **sticky sessions are still required** for tools that require **state to be maintained in-memory**; for eg.

- **Streaming or downloading a large file in chunks**: Server has to remember how much has already been delivered
- **Canary deployments**: When experimental features are rolled out to few users only
- **Per user AI model**: Need not load different AI models in same container for each new request

## A bit about WebSocket connections

**HTTP connections are ephemereal** whereas **WebSocket connections are long lived**.
- **Once the request response cycle is over the server ends the connection with the client**. This is what allows webplications to scale so well. You can run multiple instances of the same application code and the app will do its job regardless of which instance receives your http request.
- **Websockets** connections are meant to **maintain connection for extended duration**. Thats why when **Client_A** connects with **Server_1** the connection is **kept alive in-memory** of **Server_1**.
- If **Server_10** receives an event that requires it to send the data to **Client_A**
  - it has to publish it to a **redis-like pubsub system**.
  - Similarly, it subscribes to the same queue for messages to clients whose WS-Connection it has in memory.

```text
                    live WebSocket tunnel
         ┌──────────────────────────────────────┐
         │                                      │
         ▼                                      ▼
┌──────────────┐   HTTP    ┌───────┐         ┌───────┐         ┌───────┐
│ Your browser │──────────▶│ Nginx │────────▶│ app-1 │◀───────▶│ Redis │
└──────────────┘           └───────┘    ┌───▶│       │  pub/   │ queue │
                                        │    └───────┘  sub    └───┬───┘
                                        │    ┌───────┐             │
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

### Mode 1 (live version) ----------- 3 containers with 1 worker each

```text
  Your browser ──▶ Nginx ──▶ app-1 / app-2 / app-3 ──▶ Redis
                     │              ▲
                     │              │
                     └──── sticky cookie / round-robin ────┘
                     └──── live WebSocket tunnel (one home) ─┘
```

Buttons:

1. **Requests are serially delivered** to application containers **in round robin fashion**.
2. **Sticky cookie** added by app instance ensures that all **future requests reach the same instance** every time. This **includes** the **initial ws connection** request.
3. WS connections are long lived. The **same container is bound to receive** all messages sent throught that connection. If connection is broken, can **use same cookie to reconnect to same container**.
4. **Standard for managing WS** connections. **Messages are published to queue** and the container with the recipient's connection does the delivery.
5. WS response NOT GUARANTEED. **No sticky cookie** in http request. App instance that has the client's websocket session may not receive it.
6. Uses **sticky cookie** in request header. If **WebSocket connection is made with same cookie**, the **instance that receives the request will also have the connection**.

### Mode 2 ----------- 1-container-4-workers

Will work the same if the image called `app` is selected in `docker-compose.yml`.

Docker runs **FastAPI app with 4 workers** in 1 container and a **redis service** in another. The workers are identified by their `pid`.

The UI provides **4 ways to send message** to the server.
1. **http-out, http-in**
2. websockets, **ws-out, ws-in**: works all the time because the client and the server instance are connected via the websocket **connection throughout** the session
3. Makes http requests to server to **echo back the text through WS**. ws message **not guaranteed** because any instance may receive this request.
4. Makes http requests to server to **publish text to redis**, all the workers subscribe to it, **echo text is guaranteed**.

## Code implementation

### Dependencies

Redis, FastAPI, Uvicorn, Docker, Nginx

### FastAPI and Docker

[docker-compose.yml](https://github.com/kirtimukh/HTTPSticky/blob/main/docker-compose.yml)

- **3 replica containers** of the app is run
- The containers run **uvicorn server with 1 worker each**
- Nginx handles the traffic to each of these containers
<br>

- Cookie based routing cannot be used to distinguish between **multiple workers in same container**
- There's a commented out image in `docker-compose.yml` with 4 workers that can be used to verify that PubSub systems do not have that limitation.

### Nginx

See [nginx.conf](https://github.com/kirtimukh/HTTPSticky/blob/main/nginx.conf)

- **Load balancing** based on the **cookie** result in **sticky sessions**.
- For cases (like first page load) where the sticky cookie is missing **Round Robin is used as fallback**.
- **Without this fallback** all requests without the cookie will be routed to the same container.

### App flow - initial page load

See [sample logs](https://github.com/kirtimukh/HTTPSticky/blob/main/records.log)

- Browser requests `index.html`.
- FastAPI sets custom `StickyStr` cookie and returns `HTMLResponse`.
- Browser receives the html page. The `StickyStr` is also saved in session JS.
- **WebSocket connection is made** using the same cookie, Nginx ensures that connection is made with the same container that emitted the cookie.
- After connection, the **cookie is removed** from `document` *to simulate non-sticky behaviour*
<br>

- Buttons that mention 'sticky' **adds the saved StickyStr** to `document.cookie` before making the request.
- All other http requests are made **without StickyStr** and are round-robined by nginx.
- This is for demonstration only.
<br>

- Requests made with cookie generated by APP_1 does not necessarily reach APP_1 : for that cookie-container map has to be provided to load balancer.

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
                              │         Redis  ·  pubsub         │
                              └──────────────────────────────────┘
```
