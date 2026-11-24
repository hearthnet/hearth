// `hearth sell --public`: a seller with no domain of its own still serves
// buyers. One local proxy puts the node's public read port, the sponsor and
// the proof that the domain speaks for the seller behind one origin, and a
// Cloudflare quick tunnel (no account) gives that origin an https URL.

import { spawn } from "node:child_process";
import { createServer, request } from "node:http";

/** The node's public read port Hearth sets on its own node. */
export const PUBLIC_READ_PORT = 8082;

/**
 * A proxy on 127.0.0.1 (`port`, 0 for any): `/.well-known/lattice.json`
 * lists `seller` (client/vouch.mjs reads it), `/sponsor/…` goes to the
 * sponsor on `sponsorPort` without the prefix, anything else to the node's
 * public read port. Resolves to `{ port, close }` once it listens.
 */
export function startProxy({ port = 0, nodePort, sponsorPort, seller }) {
  const proof = JSON.stringify({ sellers: [seller] });
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path.split("?")[0] === "/.well-known/lattice.json") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      return res.end(proof);
    }
    const sponsor = path === "/sponsor" || path.startsWith("/sponsor/") || path.startsWith("/sponsor?");
    const to = sponsor ? sponsorPort : nodePort;
    const forwarded = request({ host: "127.0.0.1", port: to, method: req.method, path: sponsor ? path.slice("/sponsor".length) || "/" : path,
      headers: { ...req.headers, host: `127.0.0.1:${to}` } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forwarded.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }); res.end(sponsor ? "the sponsor does not answer" : "the node does not answer"); });
    req.pipe(forwarded);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok({ port: server.address().port, close: () => server.close() }));
  });
}

/**
 * A quick tunnel from an https URL to 127.0.0.1:`port` (`cloudflared`, the
 * binary at `bin`): resolves to `{ url, child }` once cloudflared prints its
 * URL, which changes each time it starts. Stops when this process exits.
 */
export function startTunnel({ bin, port, timeoutMs = 60_000 }) {
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  process.on("exit", () => child.kill("SIGTERM"));
  return new Promise((ok, fail) => {
    let said = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); fail(new Error(`cloudflared gave no URL in ${timeoutMs / 1000} s:\n${said.trim().split("\n").slice(-5).join("\n")}`)); }, timeoutMs);
    const read = (chunk) => {
      said += chunk;
      const url = said.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if (url) {
        clearTimeout(timer);
        child.stdout.off("data", read); child.stderr.off("data", read);
        child.stdout.resume(); child.stderr.resume();   // keep draining its log, or it blocks writing it
        ok({ url, child });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", (e) => { clearTimeout(timer); fail(new Error(`cloudflared: ${e.message}`)); });
    child.once("exit", (code) => { clearTimeout(timer); fail(new Error(`cloudflared exited (${code}) before giving a URL:\n${said.trim().split("\n").slice(-5).join("\n")}`)); });
  });
}
