console.log(SESSION_ID)
console.log(STICKY_STR)

let ws;
let reconnectDelay = 1000;

const theReadme = document.getElementById("link-to-md");
const responsesDiv = document.getElementById("responses");
const theForm = document.getElementById("the-form");
const toggleHttpsBtn = document.getElementById("toggle-https");
const toggleWssBtn = document.getElementById("toggle-wss");
const textInput = document.getElementById("the-input");

let showHttps = true;
let showWss = true;
let messages = [];

AUTOTEXTS = ["Pebblejoy", "Chipperdew", "Marzipip", "Jollywink", "Sunnydrop"]

function getRandomPair() {
  const shuffled = AUTOTEXTS.sort(() => 0.5 - Math.random());
  return `${shuffled[0]} ${shuffled[1]}`;
}

window.addEventListener("DOMContentLoaded", () => {
  textInput.value = getRandomPair();
});

function addMessage(type, text) {
  const div = document.createElement("div");
  div.className = "response";

  const labelNode = document.createElement("span");
  labelNode.textContent = type;
  labelNode.className = `response-label ${type}`;

  const textNode = document.createTextNode(text);

  div.appendChild(labelNode);
  div.appendChild(textNode);

  responsesDiv.appendChild(div);
  responsesDiv.scrollTop = responsesDiv.scrollHeight;
}

// --- README.md ---
theReadme.addEventListener("click", async () => {
  window.open("/readme", "_blank");
})

// --- Form Handlers ---
function wsSend(text) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ text, op: 'echo' }));
  } else {
    console.error("WebSocket not connected.");
  }
}

theForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  document.cookie = "StickyStr=;";
  const textInput = document.getElementById("the-input");
  const text = textInput.value.trim();
  if (!text) return;

  const clickedButton = e.submitter?.value;

  let theUrl;

  if (clickedButton === "ws-only") {
    wsSend(text);
    textInput.value = getRandomPair()
    return;
  }

  if (clickedButton === "http-only") {
    theUrl = "submit/" + SESSION_ID;
  } else if (clickedButton === "http-sticky") {
    document.cookie = `StickyStr=${STICKY_STR};`
    theUrl = "submit/" + SESSION_ID;
  } else if (clickedButton === "with-redis") {
    theUrl = "with-redis/" + SESSION_ID;
  } else if (clickedButton === "not-sticky") {
    theUrl = "without-redis/" + SESSION_ID;
  } else if (clickedButton === "sticky") {
    document.cookie = `StickyStr=${STICKY_STR};`
    theUrl = "without-redis/" + SESSION_ID;
  }

  try {
    const response = await fetch(theUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, op: 'echo' })
    });

    const result = await response.json();
    addMessage("https", result.text);
    document.cookie = "StickyStr=;";
  } catch (err) {
    console.error("HTTP error:", err);
  }

  textInput.value = getRandomPair();
});

// --- Filtering ---
toggleHttpsBtn.addEventListener("click", () => {
  showHttps = !showHttps;
  toggleHttpsBtn.style.opacity = showHttps ? "1" : "0.5";
  displayMessages();
});

toggleWssBtn.addEventListener("click", () => {
  showWss = !showWss;
  toggleWssBtn.style.opacity = showWss ? "1" : "0.5";
  displayMessages();
});

// --- WebSocket Connection ---
function connectWebSocket() {
  document.cookie = "StickyStr=;";
  ws = new WebSocket("ws/" + SESSION_ID);

  ws.onopen = () => {
    console.log("WebSocket connected");
    reconnectDelay = 1000; // reset delay
    document.cookie = "StickyStr=;";
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data?.text) {
      addMessage("wss", data.text);
    } else if (data?.websocket_pid) {
      const pid = data.websocket_pid;

      const span = document.getElementById("ws-pid");

      if (pid) {
        span.innerHTML = "Ws_connection: <strong>" + pid + "</strong>";
        span.style.display = "inline";  // or "block" depending on layout
      } else {
        span.style.display = "none";
      }
    }
  };

  ws.onclose = () => {
    console.warn("WebSocket closed. Reconnecting...");
    setTimeout(connectWebSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000); // exponential backoff
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    ws.close(); // trigger reconnect
  };
}

connectWebSocket();
