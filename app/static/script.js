/**
 * Graph-primary UI — path animation + live text exchange, wired to real HTTP/WS.
 * Textual feed lives in History drawer only.
 */

const PATHS = {
  "http-only": {
    label: "HTTP RR",
    kind: "paired",
    channel: "http",
    route: "/submit/{id}",
  },
  "http-sticky": {
    label: "HTTP Sticky",
    kind: "paired",
    channel: "http",
    route: "/submit/{id}",
    sticky: true,
  },
  "ws-only": {
    label: "WS Only",
    kind: "paired",
    channel: "wss",
    route: "wss echo",
  },
  "with-redis": {
    label: "Redis Pub/Sub",
    kind: "split",
    route: "/with-redis/{id}",
    guaranteed: true,
  },
  "not-sticky": {
    label: "HTTP→WS",
    kind: "split",
    route: "/without-redis/{id}",
    guaranteed: false,
  },
  sticky: {
    label: "Sticky→WS",
    kind: "split",
    route: "/without-redis/{id}",
    sticky: true,
    guaranteed: true,
  },
};

const WORDS = ["Pebblejoy", "Chipperdew", "Marzipip", "Jollywink", "Sunnydrop", "Mossflute"];

const feed = document.getElementById("feed");
const liveExchange = document.getElementById("live-exchange");
const input = document.getElementById("msg");
const historyCount = document.getElementById("history-count");
const historyOpen = document.getElementById("history-open");
const historyClose = document.getElementById("history-close");
const drawer = document.getElementById("history-drawer");
const backdrop = document.getElementById("drawer-backdrop");

const filterState = Object.fromEntries(Object.keys(PATHS).map((k) => [k, true]));
filterState.all = true;

let historyItems = 0;
let graphBusy = false;
let ws;
let reconnectDelay = 1000;

/** Node id for the instance that owns the WebSocket (e.g. "app2"). */
let WS_HOME = "app2";
/** Display label matching APP_ID (e.g. "app-2"). */
let WS_HOME_LABEL = "—";
/** Sticky cookie issuer APP_ID (e.g. "app-2"). */
let STICKY_TARGET = parseStickyTarget(STICKY_STR) || PAGE_BY || "app-2";

/** In-flight wait for a WSS delivery: { expectText, resolve, reject }. */
let pendingWsWait = null;

function parseStickyTarget(str) {
  const m = String(str || "").match(/-by-(.+)$/);
  return m ? m[1].trim() : null;
}

/** Map APP_ID label → SVG node key: "app-2" / "App_2" → "app2". */
function toNodeId(label) {
  if (!label) return null;
  const n = String(label).trim().toLowerCase().replace(/_/g, "-");
  const m = n.match(/^app-?(\d+)$/);
  if (m) return "app" + m[1];
  return n.replace(/-/g, "");
}

function parsePid(text) {
  const m = String(text || "").match(/^\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

/** Strip leading "[pid]" and optional spaces from a reply body. */
function stripPid(text) {
  return String(text || "").replace(/^\[[^\]]+\]\s*/, "");
}

function randomText() {
  const a = WORDS[Math.floor(Math.random() * WORDS.length)];
  const b = WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${a} ${b}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function flowHeadHtml(meta) {
  const stickyHtml = meta.sticky
    ? '<span class="sticky-used">sticky-str used</span>'
    : "sticky-str not used";
  return `
    <div class="flow-head">
      <span class="flow-tag">${esc(meta.label)}</span>
      <span class="flow-meta">${esc(meta.route)} · ${stickyHtml}</span>
    </div>
  `;
}

function bumpHistoryCount() {
  historyItems += 1;
  historyCount.textContent = String(historyItems);
  historyCount.classList.toggle("has-items", historyItems > 0);
}

/* —— History drawer —— */
function setHistoryOpen(open) {
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  historyOpen.setAttribute("aria-expanded", open ? "true" : "false");
  backdrop.classList.toggle("open", open);
  backdrop.hidden = !open;
  if (open) {
    feed.scrollTop = feed.scrollHeight;
    historyClose.focus();
  }
}

historyOpen.addEventListener("click", () => setHistoryOpen(true));
historyClose.addEventListener("click", () => setHistoryOpen(false));
backdrop.addEventListener("click", () => setHistoryOpen(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawer.classList.contains("open")) setHistoryOpen(false);
});

/* —— Info (i) —— */
const actionDesc = document.getElementById("action-desc");

function closeAllInfo() {
  document.querySelectorAll(".info-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  actionDesc.textContent = "";
  actionDesc.classList.remove("has-desc");
}

function showInfoFromBtn(btn) {
  const info = btn.querySelector("i");
  const text = info ? info.textContent.trim() : "";
  actionDesc.textContent = text;
  actionDesc.classList.toggle("has-desc", Boolean(text));
  document.querySelectorAll(".info-btn").forEach((b) => {
    b.setAttribute("aria-expanded", b === btn ? "true" : "false");
  });
}

function showInfoForPath(path) {
  const infoBtn = document.querySelector(`.info-btn[data-info="${path}"]`);
  if (infoBtn) showInfoFromBtn(infoBtn);
}

document.querySelectorAll(".info-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = btn.getAttribute("aria-expanded") === "true";
    if (wasOpen) {
      closeAllInfo();
    } else {
      showInfoFromBtn(btn);
    }
  });
});

function applyFilters() {
  feed.querySelectorAll(".flow").forEach((el) => {
    el.hidden = !filterState[el.dataset.path];
  });
}

document.querySelectorAll(".filter-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const key = chip.dataset.filter;
    if (key === "all") {
      const turnOn = chip.getAttribute("aria-pressed") !== "true"
        || Object.keys(PATHS).some((k) => !filterState[k]);
      Object.keys(PATHS).forEach((k) => { filterState[k] = turnOn; });
      filterState.all = turnOn;
      document.querySelectorAll(".filter-chip").forEach((c) => {
        c.setAttribute("aria-pressed", turnOn ? "true" : "false");
      });
    } else {
      filterState[key] = !filterState[key];
      chip.setAttribute("aria-pressed", filterState[key] ? "true" : "false");
      const allOn = Object.keys(PATHS).every((k) => filterState[k]);
      filterState.all = allOn;
      document.querySelector('.filter-chip[data-filter="all"]')
        .setAttribute("aria-pressed", allOn ? "true" : "false");
    }
    applyFilters();
  });
});

/* —— Message HTML builders (shared by live + history) —— */
function pairedHtml({ path, text, channel, sticky, app, replyBody }) {
  const meta = PATHS[path];
  const replyApp = app || WS_HOME_LABEL;
  const body = replyBody != null ? replyBody : text;
  return {
    app: replyApp,
    html: `
      ${flowHeadHtml(meta)}
      <div class="pair">
        <div class="msg out">
          <span class="dir">you</span>
          <span class="body">${esc(text)}</span>
        </div>
        <div class="msg in ${channel}">
          <span class="dir">${channel} ←</span>
          <span class="body">
            <span class="pid">[${esc(replyApp)}]</span>
            ${esc(body)}
          </span>
        </div>
      </div>
    `,
    channelClass: channel === "wss" ? "wss-paired" : "http-paired",
  };
}

function splitHtml({ path, text, sticky, httpApp, httpBody, willDeliver, wsApp, wsBody }) {
  const meta = PATHS[path];
  const hit = httpApp || "—";
  const deliver = !!willDeliver;

  const body = `
    ${flowHeadHtml(meta)}
    <div class="split ${deliver ? "" : "miss"}">
      <div class="lane http">
        <div class="lane-label">HTTP action</div>
        <div class="msg out">
          <span class="dir">you</span>
          <span class="body">${esc(text)}</span>
        </div>
        <div class="msg in http">
          <span class="dir">http ←</span>
          <span class="body">
            <span class="pid">[${esc(hit)}]</span>
            ${esc(httpBody || "")}
          </span>
        </div>
      </div>
      <div class="lane wss" data-ws-lane>
        <div class="lane-label">WSS response</div>
        ${deliver
          ? (wsBody != null
            ? `<div class="msg in wss">
                 <span class="dir">wss ←</span>
                 <span class="body">
                   <span class="pid">[${esc(wsApp || WS_HOME_LABEL)}]</span>
                   ${esc(wsBody)}
                 </span>
               </div>`
            : `<p class="pending-note">waiting for subscriber…</p>`)
          : `<p class="pending-note">No WSS delivery — request hit ${esc(hit)}, WS lives on ${esc(WS_HOME_LABEL)}.</p>`}
      </div>
    </div>
  `;

  return { httpApp: hit, willDeliver: deliver, html: body, pendingWs: deliver && wsBody == null };
}

function appendToHistory(html, path, extraClass) {
  const wrap = document.createElement("article");
  wrap.className = "flow" + (extraClass ? " " + extraClass : "");
  wrap.dataset.path = path;
  wrap.innerHTML = html;
  wrap.hidden = !filterState[path];
  feed.appendChild(wrap);
  bumpHistoryCount();
  return wrap;
}

function showLive(html, path, extraClass) {
  liveExchange.innerHTML = "";
  const wrap = document.createElement("article");
  wrap.className = "flow" + (extraClass ? " " + extraClass : "");
  wrap.dataset.path = path;
  wrap.innerHTML = html;
  liveExchange.appendChild(wrap);
  return wrap;
}

function revealWsDelivery(liveEl, histEl, wsApp, wsBody) {
  const apply = (root) => {
    if (!root) return;
    root.classList.remove("pending");
    const lane = root.querySelector("[data-ws-lane]");
    if (!lane) return;
    lane.innerHTML = `
      <div class="lane-label">WSS response</div>
      <div class="msg in wss">
        <span class="dir">wss ←</span>
        <span class="body">
          <span class="pid">[${esc(wsApp)}]</span>
          ${esc(wsBody)}
        </span>
      </div>
    `;
  };
  apply(liveEl);
  apply(histEl);
}

function markPendingWs(liveEl, histEl) {
  const apply = (root) => {
    if (!root) return;
    root.classList.add("pending");
    const lane = root.querySelector("[data-ws-lane]");
    if (lane) {
      lane.innerHTML = `
        <div class="lane-label">WSS response</div>
        <p class="pending-note">waiting for subscriber…</p>
      `;
    }
  };
  apply(liveEl);
  apply(histEl);
}

/* —— Graphical topology —— */
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (t) => document.createElementNS(SVGNS, t);

const NODES = {
  laptop: { x: 176, y: 330, w: 240, h: 100, label: "Your browser" },
  nginx:  { x: 430, y: 330, w: 168, h: 100, label: "Nginx" },
  app1:   { x: 700, y: 120, w: 168, h: 100, label: "app-1" },
  app2:   { x: 700, y: 330, w: 168, h: 100, label: "app-2" },
  app3:   { x: 700, y: 540, w: 168, h: 100, label: "app-3" },
  redis:  { x: 960, y: 330, w: 168, h: 100, label: "Redis" },
};

const COLOR = { http: "#1f9a8a", ws: "#c4842a", pub: "#3a7fd4", cookie: "#8b5fd4", danger: "#c45c5c" };

const edgesLayer = document.getElementById("edges");
const nodesLayer = document.getElementById("nodes");
const trailsLayer = document.getElementById("trails");
const packetsLayer = document.getElementById("packets");
const annotationsLayer = document.getElementById("annotations");
const fxLayer = document.getElementById("fx");
const stage = document.getElementById("stage");

function anchor(id, side) {
  const n = NODES[id], hx = n.w / 2, hy = n.h / 2;
  if (side === "left") return { x: n.x - hx, y: n.y };
  if (side === "right") return { x: n.x + hx, y: n.y };
  if (side === "top") return { x: n.x, y: n.y - hy };
  return { x: n.x, y: n.y + hy };
}

function line(fromId, fromSide, toId, toSide) {
  const a = anchor(fromId, fromSide), b = anchor(toId, toSide);
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

function tunnel(reverse, homeId) {
  const home = homeId || WS_HOME;
  const a = anchor("laptop", "top"), b = anchor(home, "top");
  const cx = (a.x + b.x) / 2, cy = Math.min(a.y, b.y) - 185;
  return reverse
    ? `M ${b.x} ${b.y} Q ${cx} ${cy} ${a.x} ${a.y}`
    : `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}

function drawStaticEdges() {
  edgesLayer.innerHTML = "";
  annotationsLayer.innerHTML = "";

  const structural = [
    line("laptop", "right", "nginx", "left"),
    line("nginx", "right", "app1", "left"),
    line("nginx", "right", "app2", "left"),
    line("nginx", "right", "app3", "left"),
    line("app1", "right", "redis", "left"),
    line("app2", "right", "redis", "left"),
    line("app3", "right", "redis", "left"),
  ];
  for (const d of structural) {
    const p = svgEl("path");
    p.setAttribute("class", "edge");
    p.setAttribute("d", d);
    edgesLayer.appendChild(p);
  }
  const t = svgEl("path");
  t.setAttribute("class", "edge tunnel");
  t.setAttribute("d", tunnel(false));
  edgesLayer.appendChild(t);

  const ta = anchor("laptop", "top");
  const tb = anchor(WS_HOME, "top");
  const tcx = (ta.x + tb.x) / 2;
  const tcy = Math.min(ta.y, tb.y) - 185;
  const peakY = 0.25 * ta.y + 0.5 * tcy + 0.25 * tb.y;

  const label = svgEl("text");
  label.setAttribute("class", "tunnel-label");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("x", tcx);
  label.setAttribute("y", peakY - 10);
  label.textContent = "live WebSocket tunnel";
  annotationsLayer.appendChild(label);
}

function drawNodes() {
  nodesLayer.innerHTML = "";
  for (const [id, n] of Object.entries(NODES)) {
    const g = svgEl("g");
    const isWsHome = id === WS_HOME;
    g.setAttribute("class", "node" + (isWsHome ? " role-ws" : ""));
    g.id = "node-" + id;
    g.setAttribute("transform", `translate(${n.x},${n.y})`);

    const shell = svgEl("rect");
    shell.setAttribute("class", "shell");
    shell.setAttribute("x", -n.w / 2);
    shell.setAttribute("y", -n.h / 2);
    shell.setAttribute("width", n.w);
    shell.setAttribute("height", n.h);
    shell.setAttribute("rx", 12);
    g.appendChild(shell);

    if (isWsHome) {
      const mark = svgEl("rect");
      mark.setAttribute("class", "sticky-mark");
      mark.setAttribute("x", n.w / 2 - 16);
      mark.setAttribute("y", -n.h / 2 + 8);
      mark.setAttribute("width", 10);
      mark.setAttribute("height", 10);
      mark.setAttribute("rx", 2);
      g.appendChild(mark);
    }

    const t = svgEl("text");
    t.setAttribute("class", "nlabel");
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    t.setAttribute("y", 1);
    t.textContent = n.label;
    g.appendChild(t);

    nodesLayer.appendChild(g);
  }
}

function setWsHome(label) {
  if (!label) return;
  const nodeId = toNodeId(label);
  if (!nodeId || !NODES[nodeId]) return;

  WS_HOME_LABEL = label;
  WS_HOME = nodeId;
  document.getElementById("meta-ws").textContent = label;

  const keepActive = !graphBusy;
  drawStaticEdges();
  drawNodes();
  if (keepActive) {
    document.getElementById("node-" + WS_HOME)?.classList.add("active");
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => 1 - Math.pow(1 - t, 2.4);

function animateAlong(d, color, duration = 780) {
  return new Promise((resolve) => {
    const trail = svgEl("path");
    trail.setAttribute("class", "trail");
    trail.setAttribute("d", d);
    trail.setAttribute("stroke", color);
    trail.style.color = color;
    trailsLayer.appendChild(trail);

    const len = trail.getTotalLength();
    trail.style.strokeDasharray = String(len);
    trail.style.strokeDashoffset = String(len);

    const chip = svgEl("g");
    chip.setAttribute("class", "packet-chip");
    packetsLayer.appendChild(chip);

    const body = svgEl("circle");
    body.setAttribute("r", 7);
    body.setAttribute("fill", color);
    body.setAttribute("stroke", "#ffffff");
    body.setAttribute("stroke-width", "2");
    chip.appendChild(body);

    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      const p = trail.getPointAtLength(e * len);
      chip.setAttribute("transform", `translate(${p.x},${p.y})`);
      trail.style.strokeDashoffset = String(len - e * len);
      if (t < 1) requestAnimationFrame(frame);
      else setTimeout(() => { chip.remove(); resolve(); }, 120);
    }
    requestAnimationFrame(frame);
  });
}

function pulse(ids) {
  (ids || []).forEach((id) => document.getElementById("node-" + id)?.classList.add("active"));
}

function markSkipped(exceptId) {
  ["app1", "app2", "app3"].forEach((id) => {
    if (id !== exceptId) document.getElementById("node-" + id)?.classList.add("skipped");
  });
}

function showCookieFx() {
  const n = NODES.laptop;
  const g = svgEl("g");
  g.id = "cookie-fx";
  const bg = svgEl("rect");
  bg.setAttribute("x", n.x - 48);
  bg.setAttribute("y", n.y - n.h / 2 - 28);
  bg.setAttribute("width", 96);
  bg.setAttribute("height", 18);
  bg.setAttribute("rx", 9);
  bg.setAttribute("fill", "rgba(139,95,212,0.14)");
  bg.setAttribute("stroke", COLOR.cookie);
  bg.setAttribute("stroke-width", "1");
  const t = svgEl("text");
  t.setAttribute("x", n.x);
  t.setAttribute("y", n.y - n.h / 2 - 15);
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("fill", COLOR.cookie);
  t.setAttribute("font-family", "IBM Plex Mono, monospace");
  t.setAttribute("font-size", "9");
  t.setAttribute("font-weight", "600");
  t.textContent = "StickyStr set";
  g.appendChild(bg);
  g.appendChild(t);
  fxLayer.appendChild(g);
}

function clearStage() {
  trailsLayer.innerHTML = "";
  packetsLayer.innerHTML = "";
  fxLayer.innerHTML = "";
  document.querySelectorAll(".node").forEach((n) => n.classList.remove("active", "miss", "skipped"));
  document.getElementById("node-" + WS_HOME)?.classList.add("active");
  stage.classList.remove("animating");
}

function resolveAppNode(label, fallbackLabel) {
  return toNodeId(label) || toNodeId(fallbackLabel) || WS_HOME || "app2";
}

/**
 * Build animation steps from the same APP_IDs used in the message UI.
 * exchange fields: app, httpApp, willDeliver, sticky
 */
function buildSteps(path, exchange) {
  const { http: H, ws: W, pub: P } = COLOR;
  switch (path) {
    case "http-only": {
      const app = resolveAppNode(exchange.app);
      return {
        sticky: false,
        steps: [
          { d: line("laptop", "right", "nginx", "left"), color: H, nodes: ["nginx"] },
          { d: line("nginx", "right", app, "left"), color: H, nodes: [app], skipOthers: app },
          { d: line(app, "left", "nginx", "right"), color: H, nodes: ["nginx"] },
          { d: line("nginx", "left", "laptop", "right"), color: H, nodes: ["laptop"] },
        ],
      };
    }
    case "http-sticky": {
      const app = resolveAppNode(exchange.app, STICKY_TARGET);
      return {
        sticky: true,
        steps: [
          { d: line("laptop", "right", "nginx", "left"), color: H, nodes: ["nginx"], cookie: true },
          { d: line("nginx", "right", app, "left"), color: H, nodes: [app], skipOthers: app },
          { d: line(app, "left", "nginx", "right"), color: H, nodes: ["nginx"] },
          { d: line("nginx", "left", "laptop", "right"), color: H, nodes: ["laptop"] },
        ],
      };
    }
    case "ws-only": {
      return {
        sticky: false,
        steps: [
          { d: tunnel(false), color: W, nodes: [WS_HOME] },
          { d: tunnel(true), color: W, nodes: ["laptop"] },
        ],
      };
    }
    case "with-redis": {
      const app = resolveAppNode(exchange.httpApp);
      return {
        sticky: false,
        steps: [
          { d: line("laptop", "right", "nginx", "left"), color: H, nodes: ["nginx"] },
          { d: line("nginx", "right", app, "left"), color: H, nodes: [app], skipOthers: app },
          { d: line(app, "right", "redis", "left"), color: P, nodes: ["redis"] },
          { d: line("redis", "left", WS_HOME, "right"), color: P, nodes: [WS_HOME] },
          { d: tunnel(true), color: W, nodes: ["laptop"], waitWs: true },
        ],
      };
    }
    case "sticky": {
      const app = resolveAppNode(exchange.httpApp, STICKY_TARGET);
      const steps = [
        { d: line("laptop", "right", "nginx", "left"), color: H, nodes: ["nginx"], cookie: true },
        { d: line("nginx", "right", app, "left"), color: H, nodes: [app], skipOthers: app },
      ];
      if (exchange.willDeliver) {
        steps.push({ d: tunnel(true), color: W, nodes: ["laptop"], waitWs: true });
      } else {
        steps.push({ miss: true, node: app });
      }
      return { sticky: true, steps };
    }
    case "not-sticky": {
      const app = resolveAppNode(exchange.httpApp);
      const steps = [
        { d: line("laptop", "right", "nginx", "left"), color: H, nodes: ["nginx"] },
        { d: line("nginx", "right", app, "left"), color: H, nodes: [app], skipOthers: app },
      ];
      if (exchange.willDeliver) {
        steps.push({ d: tunnel(true), color: W, nodes: ["laptop"], waitWs: true });
      } else {
        steps.push({ miss: true, node: app });
      }
      return { sticky: false, steps };
    }
  }
}

async function missStep(s) {
  const g = document.getElementById("node-" + s.node);
  if (!g) return;
  g.classList.remove("active");
  g.classList.add("miss");
  const n = NODES[s.node];
  const x = svgEl("text");
  x.setAttribute("text-anchor", "middle");
  x.setAttribute("x", n.x);
  x.setAttribute("y", n.y - 6);
  x.setAttribute("fill", COLOR.danger);
  x.setAttribute("font-size", "28");
  x.setAttribute("font-weight", "700");
  x.setAttribute("font-family", "DM Sans, sans-serif");
  x.setAttribute("filter", "url(#softglow)");
  x.textContent = "✕";
  packetsLayer.appendChild(x);

  const note = svgEl("text");
  note.setAttribute("text-anchor", "middle");
  note.setAttribute("x", n.x);
  note.setAttribute("y", n.y + 22);
  note.setAttribute("fill", COLOR.danger);
  note.setAttribute("font-family", "IBM Plex Mono, monospace");
  note.setAttribute("font-size", "11");
  note.setAttribute("font-weight", "600");
  note.textContent = "no WS session";
  packetsLayer.appendChild(note);
  await wait(900);
}

/* —— Network —— */
function clearStickyCookie() {
  document.cookie = "StickyStr=;";
}

function setStickyCookie() {
  document.cookie = `StickyStr=${STICKY_STR};`;
}

async function httpPost(url, text) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, op: "echo" }),
  });
  return response.json();
}

function waitForWsText(expectText, timeoutMs = 8000) {
  let settled = false;
  let timer;

  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingWsWait = null;
      reject(new Error("Timed out waiting for WebSocket delivery"));
    }, timeoutMs);

    pendingWsWait = {
      expectText,
      resolve: (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingWsWait = null;
        resolve(data);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingWsWait = null;
        resolve(null);
      },
    };
  });
}

/** Cancel an armed waiter without treating it as a delivery (e.g. HTTP miss). */
function cancelWsWait() {
  pendingWsWait?.cancel?.();
}

function wsSend(text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ text, op: "echo" }));
    return true;
  }
  console.error("WebSocket not connected.");
  return false;
}

async function runHttpSteps(steps, wsPromise) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.cookie) showCookieFx();
    if (s.miss) {
      await missStep(s);
    } else if (s.waitWs && wsPromise) {
      const wsData = await wsPromise;
      if (!wsData?.text) return null;
      await animateAlong(s.d, s.color, 780);
      pulse(s.nodes);
      if (s.skipOthers) markSkipped(s.skipOthers);
      return wsData;
    } else {
      await animateAlong(s.d, s.color, 780);
      pulse(s.nodes);
      if (s.skipOthers) markSkipped(s.skipOthers);
    }
    await wait(140);
  }
  return null;
}

async function runAction(path) {
  if (graphBusy) return;
  graphBusy = true;
  document.querySelectorAll(".action").forEach((b) => (b.disabled = true));
  showInfoForPath(path);

  const text = input.value.trim() || randomText();
  input.value = text;
  const meta = PATHS[path];

  clearStickyCookie();
  if (meta.sticky) setStickyCookie();

  try {
    let exchange;
    let liveEl;
    let histEl;
    let wsPromise = null;

    if (path === "ws-only") {
      const wsPromiseOnly = waitForWsText(text);
      if (!wsSend(text)) {
        cancelWsWait();
        throw new Error("WebSocket not connected");
      }
      const wsData = await wsPromiseOnly;
      if (!wsData?.text) throw new Error("No WebSocket echo received");
      const pid = parsePid(wsData.text) || WS_HOME_LABEL;
      const body = stripPid(wsData.text);
      const built = pairedHtml({
        path,
        text,
        channel: "wss",
        sticky: false,
        app: pid,
        replyBody: body,
      });
      exchange = {
        kind: "paired",
        path,
        app: pid,
        channel: "wss",
        sticky: false,
        html: built.html,
        channelClass: built.channelClass,
      };
      liveEl = showLive(exchange.html, path, exchange.channelClass);
      histEl = appendToHistory(exchange.html, path, exchange.channelClass);

      clearStage();
      stage.classList.add("animating");
      const { steps } = buildSteps(path, exchange);
      await runHttpSteps(steps, null);
    } else if (meta.kind === "paired") {
      const result = await httpPost("submit/" + SESSION_ID, text);
      clearStickyCookie();
      const pid = parsePid(result.text) || (meta.sticky ? STICKY_TARGET : "—");
      const body = stripPid(result.text);
      const built = pairedHtml({
        path,
        text,
        channel: "http",
        sticky: !!meta.sticky,
        app: pid,
        replyBody: body,
      });
      exchange = {
        kind: "paired",
        path,
        app: pid,
        channel: "http",
        sticky: !!meta.sticky,
        html: built.html,
        channelClass: built.channelClass,
      };
      liveEl = showLive(exchange.html, path, exchange.channelClass);
      histEl = appendToHistory(exchange.html, path, exchange.channelClass);

      clearStage();
      stage.classList.add("animating");
      const { steps, sticky } = buildSteps(path, exchange);
      if (sticky) showCookieFx();
      await runHttpSteps(steps, null);
    } else {
      /* Split paths — arm WS waiter before HTTP so early deliveries are not missed */
      let url;
      if (path === "with-redis") url = "with-redis/" + SESSION_ID;
      else url = "without-redis/" + SESSION_ID;

      wsPromise = waitForWsText(text);
      const result = await httpPost(url, text);
      clearStickyCookie();

      const httpApp = parsePid(result.text) || "—";
      const httpBody = stripPid(result.text);
      const isMiss = /no connection/i.test(result.text);
      const willDeliver = !isMiss;

      if (!willDeliver) {
        cancelWsWait();
        wsPromise = null;
      }

      const built = splitHtml({
        path,
        text,
        sticky: !!meta.sticky,
        httpApp,
        httpBody,
        willDeliver,
        wsApp: null,
        wsBody: null,
      });

      exchange = {
        kind: "split",
        path,
        sticky: !!meta.sticky,
        httpApp,
        willDeliver,
        html: built.html,
      };

      liveEl = showLive(exchange.html, path, "");
      histEl = appendToHistory(exchange.html, path, "");
      if (willDeliver) markPendingWs(liveEl, histEl);

      clearStage();
      stage.classList.add("animating");
      const { steps, sticky } = buildSteps(path, exchange);
      if (sticky) showCookieFx();

      let wsData = null;
      try {
        wsData = await runHttpSteps(steps, wsPromise);
      } catch (err) {
        console.error(err);
      }

      if (willDeliver && wsData?.text) {
        const wsApp = parsePid(wsData.text) || WS_HOME_LABEL;
        const wsBody = stripPid(wsData.text);
        revealWsDelivery(liveEl, histEl, wsApp, wsBody);
      } else if (willDeliver) {
        const applyFail = (root) => {
          if (!root) return;
          root.classList.remove("pending");
          const lane = root.querySelector("[data-ws-lane]");
          if (lane) {
            lane.innerHTML = `
              <div class="lane-label">WSS response</div>
              <p class="pending-note">No WSS delivery received.</p>
            `;
          }
        };
        applyFail(liveEl);
        applyFail(histEl);
      }
    }

    stage.classList.remove("animating");
  } catch (err) {
    console.error("Action error:", err);
    clearStickyCookie();
    stage.classList.remove("animating");
  }

  input.value = randomText();
  graphBusy = false;
  document.querySelectorAll(".action").forEach((b) => (b.disabled = false));
}

/* —— Shared actions —— */
function bindHoverLock(el) {
  el.addEventListener("pointerup", () => {
    el.classList.add("hover-lock");
    el.blur();
  });
  el.addEventListener("pointerleave", () => el.classList.remove("hover-lock"));
}

document.querySelectorAll(".action").forEach((btn) => {
  bindHoverLock(btn);
  btn.addEventListener("click", () => runAction(btn.dataset.path));
});

document.querySelectorAll(".info-btn").forEach(bindHoverLock);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runAction("http-only");
  }
});

/* —— WebSocket —— */
function connectWebSocket() {
  // Restore StickyStr so Nginx hashes initial connect and reconnects to the same upstream.
  setStickyCookie();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/${SESSION_ID}`);

  ws.onopen = () => {
    console.log("WebSocket connected");
    reconnectDelay = 1000;
    clearStickyCookie();
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data?.websocket_pid) {
      setWsHome(data.websocket_pid);
      return;
    }

    if (data?.text && pendingWsWait) {
      pendingWsWait.resolve(data);
    }
  };

  ws.onclose = () => {
    console.warn("WebSocket closed. Reconnecting...");
    setTimeout(connectWebSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    ws.close();
  };
}

/* —— Init —— */
document.getElementById("meta-page").textContent = PAGE_BY || "—";
document.getElementById("meta-sticky").textContent = STICKY_TARGET || "—";
document.getElementById("meta-client").textContent = SESSION_ID || "—";
document.getElementById("meta-ws").textContent = WS_HOME_LABEL;

input.value = randomText();

drawStaticEdges();
drawNodes();
document.getElementById("node-" + WS_HOME)?.classList.add("active");

connectWebSocket();
