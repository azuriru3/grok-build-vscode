/**
 * Plain HTML/CSS/JS webview, no framework. This UI is a message log, a text
 * box, and a send button, that doesn't need one.
 */
import * as vscode from "vscode";

function nonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

export function getWebviewHtml(webview: vscode.Webview): string {
  const scriptNonce = nonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${scriptNonce}'`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Grok Build</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  #log {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
  }
  .entry {
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
  }
  .user-msg {
    font-weight: 600;
    white-space: pre-wrap;
  }
  .agent-update {
    white-space: pre-wrap;
    font-size: 0.95em;
    margin-top: 4px;
    opacity: 0.9;
  }
  .done { font-size: 0.85em; opacity: 0.7; margin-top: 4px; }
  .error {
    color: var(--vscode-errorForeground);
    white-space: pre-wrap;
  }
  #composer {
    display: flex;
    padding: 8px;
    border-top: 1px solid var(--vscode-widget-border, #444);
  }
  #input {
    flex: 1;
    resize: none;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px;
    font-family: inherit;
  }
  #send {
    margin-left: 8px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 0 14px;
    cursor: pointer;
  }
  #send:disabled { opacity: 0.5; cursor: default; }
  details.raw-toggle {
    margin-top: 6px;
    font-size: 0.8em;
  }
  details.raw-toggle summary { cursor: pointer; opacity: 0.7; }
  details.raw-toggle pre {
    white-space: pre-wrap;
    word-break: break-all;
    background: var(--vscode-textCodeBlock-background, #222);
    padding: 6px;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
</head>
<body>
  <div id="log"></div>
  <div id="composer">
    <textarea id="input" rows="2" placeholder="Describe what you want Grok Build to do..."></textarea>
    <button id="send">Send</button>
  </div>

<script nonce="${scriptNonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const input = document.getElementById("input");
  const send = document.getElementById("send");

  const requestEntries = new Map(); // requestId -> DOM element

  function el(tag, opts) {
    const e = document.createElement(tag);
    if (opts?.className) e.className = opts.className;
    if (opts?.text !== undefined) e.textContent = opts.text;
    return e;
  }

  function ensureRequestEntry(requestId) {
    let entry = requestEntries.get(requestId);
    if (!entry) {
      entry = el("div", { className: "entry" });
      entry.dataset.requestId = requestId;
      log.appendChild(entry);
      requestEntries.set(requestId, entry);
    }
    return entry;
  }

  function latestEntry() {
    const entries = [...requestEntries.values()];
    return entries.length ? entries[entries.length - 1] : log;
  }

  function appendRaw(container, payload) {
    const details = el("details", { className: "raw-toggle" });
    details.appendChild(el("summary", { text: "raw JSON" }));
    const pre = el("pre", { text: JSON.stringify(payload, null, 2) });
    details.appendChild(pre);
    container.appendChild(details);
  }

  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    send.disabled = true;
    vscode.postMessage({ type: "submit", text });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "userMessage": {
        const entry = ensureRequestEntry(msg.requestId);
        entry.appendChild(el("div", { className: "user-msg", text: msg.text }));
        break;
      }
      case "agentUpdate": {
        latestEntry().appendChild(el("div", { className: "agent-update", text: msg.text }));
        break;
      }
      case "done": {
        const entry = ensureRequestEntry(msg.requestId);
        entry.appendChild(el("div", { className: "done", text: "Done [" + msg.stopReason + "]" }));
        send.disabled = false;
        break;
      }
      case "error": {
        const entry = msg.requestId ? ensureRequestEntry(msg.requestId) : el("div", { className: "entry" });
        if (!msg.requestId) log.appendChild(entry);
        entry.appendChild(el("div", { className: "error", text: "Error: " + msg.message }));
        send.disabled = false;
        break;
      }
      case "raw": {
        appendRaw(latestEntry(), msg.payload);
        break;
      }
    }
    log.scrollTop = log.scrollHeight;
  });
</script>
</body>
</html>`;
}
