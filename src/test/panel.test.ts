/**
 * getWebviewHtml only reads webview.cspSource, so a minimal stub is enough,
 * no real `vscode` module needed (see the file header in panel.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getWebviewHtml } from "../webview/panel";

test("the CSP script-src nonce matches the inline <script> tag's nonce", () => {
  const html = getWebviewHtml({ cspSource: "vscode-webview://dummy" } as never);

  const cspNonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
  const scriptTagNonce = html.match(/<script nonce="([^"]+)">/)?.[1];

  assert.ok(cspNonce, "CSP should declare a script-src nonce");
  assert.ok(scriptTagNonce, "the inline <script> tag should carry a nonce attribute");
  assert.equal(
    scriptTagNonce,
    cspNonce,
    "CSP and <script> nonce must match, otherwise the browser blocks the panel's own script",
  );
});

test("the panel has a stop control wired to a cancel message, hidden until a request is in flight", () => {
  const html = getWebviewHtml({ cspSource: "vscode-webview://dummy" } as never);

  assert.match(html, /<button id="stop" hidden>Stop<\/button>/);
  assert.match(html, /stop\.addEventListener\("click", \(\) => \{\s*vscode\.postMessage\(\{ type: "cancel" \}\);/);
});
