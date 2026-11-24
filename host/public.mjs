// `hearth sell --public`: a seller with no domain of its own is still
// reachable. One local proxy puts the node's public read port and the
// sponsor behind one origin, and a Cloudflare quick tunnel (no account)
// gives that origin an https URL.

import { spawn } from "node:child_process";
import { createServer, request } from "node:http";

// Hop-by-hop headers (RFC 9110 §7.6.1): about one connection, never forwarded.
const HOP = new Set(["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The node's public read port Hearth sets on its own node. */
export const PUBLIC_READ_PORT = 8082;

/**
 * A proxy on 127.0.0.1 (`port`, 0 for any): `/sponsor/…` goes to the
 * sponsor on `sponsorPort` without the prefix, anything else to the node's
 * public read port. Resolves to `{ port, close }` once it listens.
 */
export function startProxy({ port = 0, nodePort, sponsorPort }) {
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const sponsor = path === "/sponsor" || path.startsWith("/sponsor/") || path.startsWith("/sponsor?");
    const to = sponsor ? sponsorPort : nodePort;
    const rest = sponsor ? path.slice("/sponsor".length) : path;
    // End to end headers only, and none a client could use to pose as another address.
    const named = new Set(String(req.headers.connection ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));
    // The body's framing always stays, whatever Connection names: the node must see where the body ends.
    const framing = (k) => k === "transfer-encoding" || k === "content-length";
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => framing(k) || (!HOP.has(k) && !named.has(k) && !k.startsWith("proxy-") && !k.startsWith("x-forwarded-") && k !== "forwarded" && k !== "x-real-ip")));
    const forwarded = request({ host: "127.0.0.1", port: to, method: req.method, path: rest.startsWith("/") ? rest : `/${rest}`,
      headers: { ...headers, host: `127.0.0.1:${to}` } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, Object.fromEntries(Object.entries(answer.headers).filter(([k]) => !HOP.has(k))));
      answer.pipe(res);
      answer.on("error", () => res.destroy());
    });
    forwarded.on("error", () => {
      if (res.headersSent) return res.destroy();   // cut short: never a body with an error tacked on
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(sponsor ? "the sponsor does not answer" : "the node does not answer");
    });
    res.on("close", () => { if (!res.writableFinished) forwarded.destroy(); });
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

/**
 * `startTunnel`, tried again when Cloudflare refuses a quick tunnel for now
 * (it rate-limits them: HTTP 429) or cloudflared fails: waits of `delaysMs`
 * between tries, then the last failure.
 */
export async function openTunnel({ bin, port, log = () => {}, delaysMs = [15_000, 30_000, 60_000, 120_000, 240_000], start = startTunnel }) {
  for (let i = 0; ; i++) {
    try { return await start({ bin, port }); } catch (e) {
      if (i >= delaysMs.length) throw e;
      const why = e.message.match(/status \d+[^\n]*/)?.[0] ?? e.message.split("\n")[0];
      log(`no quick tunnel yet (${why}): trying again in ${delaysMs[i] / 1000} s`);
      await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
}
