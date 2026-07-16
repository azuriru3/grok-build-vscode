/**
 * Plain HTML/CSS/JS webview, no framework. This UI (a message log, a text
 * box, a couple of buttons) doesn't need one.
 */
import * as vscode from "vscode";

function nonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

export function getWebviewHtml(webview: vscode.Webview): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce()}'`,
  ].join("; ");
  const scriptNonce = nonce();

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
  .badge {
    display: inline-block;
    font-size: 0.85em;
    font-weight: 600;
    padding: 1px 8px;
    border-radius: 10px;
    margin: 4px 0;
  }
  .badge-trivial { background: var(--vscode-charts-green, #2ea043); color: white; }
  .badge-complex { background: var(--vscode-charts-purple, #8957e5); color: white; }
  .reasoning { font-size: 0.85em; opacity: 0.75; margin-bottom: 4px; }
  .step {
    margin: 4px 0 4px 12px;
    padding: 4px 8px;
    border-left: 2px solid var(--vscode-textLink-foreground);
  }
  .step-instruction { font-weight: 600; }
  .step-summary { white-space: pre-wrap; font-size: 0.95em; margin-top: 2px; }
  .error {
    color: var(--vscode-errorForeground);
    white-space: pre-wrap;
  }
  .escalate-btn, .restart-btn {
    font-size: 0.8em;
    margin-left: 8px;
    cursor: pointer;
    background: none;
    border: 1px solid var(--vscode-button-border, #555);
    color: var(--vscode-foreground);
    border-radius: 4px;
    padding: 1px 6px;
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
    if (opts?.html !== undefined) e.innerHTML = opts.html;
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
      case "classified": {
        const entry = ensureRequestEntry(msg.requestId);
        const badge = el("span", {
          className: "badge " + (msg.complexity === "trivial" ? "badge-trivial" : "badge-complex"),
          text: msg.complexity === "trivial" ? "Trivial → Grok Build" : "Complex → Fable 5 planning",
        });
        entry.appendChild(badge);
        if (msg.complexity === "trivial") {
          const escalateBtn = el("button", { className: "escalate-btn", text: "Escalate to complex" });
          escalateBtn.addEventListener("click", () => {
            escalateBtn.disabled = true;
            vscode.postMessage({ type: "escalate", requestId: msg.requestId });
          });
          entry.appendChild(escalateBtn);
        }
        entry.appendChild(el("div", { className: "reasoning", text: msg.reasoning }));
        break;
      }
      case "planUpdated": {
        const entry = ensureRequestEntry(msg.requestId);
        const badge = entry.querySelector(".badge-complex");
        if (badge) badge.textContent = "Complex → Fable 5 planning, " + msg.subtasks.length + " steps";
        break;
      }
      case "stepStarted": {
        const entry = ensureRequestEntry(msg.requestId);
        const step = el("div", { className: "step" });
        step.dataset.stepIndex = String(msg.index);
        step.appendChild(el("div", { className: "step-instruction", text: "Step " + msg.index + ": " + msg.instruction }));
        step.appendChild(el("div", { className: "step-summary", text: "(running...)" }));
        entry.appendChild(step);
        break;
      }
      case "stepCompleted": {
        const entry = ensureRequestEntry(msg.requestId);
        const step = entry.querySelector('.step[data-step-index="' + msg.index + '"]');
        if (step) {
          const summaryEl = step.querySelector(".step-summary");
          summaryEl.textContent = (msg.summary || "(no output captured)") + "  [" + msg.stopReason + "]";
        }
        break;
      }
      case "done": {
        const entry = ensureRequestEntry(msg.requestId);
        entry.appendChild(el("div", { className: "reasoning", text: "Done (" + msg.totalSteps + " step" + (msg.totalSteps === 1 ? "" : "s") + ")." }));
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
        // Global raw ACP traffic log, appended to the most recent entry so it
        // stays roughly in context without needing per-message correlation.
        const entries = [...requestEntries.values()];
        const container = entries.length ? entries[entries.length - 1] : log;
        appendRaw(container, msg.payload);
        break;
      }
    }
    log.scrollTop = log.scrollHeight;
  });
</script>
</body>
</html>`;
}
