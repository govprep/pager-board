// Tests for routing a single live instance through a proxy.
//
// Run: npm test
//
// Why this exists: pager.forcequit.xyz answers 403 to this feeder's IP — a
// Cloudflare WAF rule on the zone, not something headers can talk their way
// past — while the same request from a residential connection is waved through.
// So one instance, and only one, dials out through a SOCKS5 proxy parked on
// such a connection. Everything else keeps its direct path.
//
// The contract being pinned here is engine.io's, and it is not obvious from the
// outside: `createTransport` builds each transport with
// `agent: options.agent || this.agent` (engine.io-client/lib/socket.js:178),
// where `this.agent` is the top-level option. Both transports then use it — the
// ws upgrade at transports/websocket.js:99, and the XHR handshake that carries
// the connection at transports/polling-xhr.js:78. One top-level `agent` is
// therefore enough to cover the whole connection, and it must arrive as the
// *same object* rather than a copy, because an http.Agent that has been cloned
// is no longer an agent.
//
// The negative case matters just as much: on a box with no tunnel the options
// must come out byte-for-byte as they were before any of this existed, so the
// four unproxied instances cannot be disturbed by a feature they don't use.

import test from "node:test";
import assert from "node:assert/strict";

import { liveSocketOptions, proxyAgentFor, type LiveInstance } from "./sources/pagermon-live";
import { withProxy, PUBLIC_INSTANCES } from "./sources/public-pagermon";

const inst: LiveInstance = { label: "test", baseUrl: "https://pager.example" };

/** Set an env var for one call and put the environment back afterwards. */
function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = before;
    else delete process.env[key];
  }
}

test("without a proxy, the options carry no agent key at all", () => {
  const opts = liveSocketOptions(inst);
  assert.equal("agent" in opts, false, "an undefined agent would still disable engine.io's default");
});

test("without a proxy, the options are what they have always been", () => {
  const opts = liveSocketOptions(inst);
  assert.deepEqual(opts.transports, ["polling", "websocket"]);
  assert.equal(opts.reconnection, true);
  assert.equal(opts.reconnectionDelay, 5000);
  assert.equal(opts.reconnectionDelayMax, 30_000);
  // The Cloudflare headers are the reason the other instances connect at all.
  const headers = opts.extraHeaders as Record<string, string>;
  assert.match(headers["User-Agent"], /^Mozilla\/5\.0 /);
  assert.equal(headers.Origin, "https://pager.example");
  assert.equal(headers.Referer, "https://pager.example/");
  const perTransport = opts.transportOptions as Record<string, { extraHeaders: unknown }>;
  assert.equal(perTransport.polling.extraHeaders, headers);
  assert.equal(perTransport.websocket.extraHeaders, headers);
});

test("with a proxy, the agent rides on the option engine.io actually reads", () => {
  const agent = { sentinel: true };
  const opts = liveSocketOptions(inst, agent);
  // Identity, not equality: a deep-copied agent is a dead agent.
  assert.equal(opts.agent, agent);
});

test("a proxied instance keeps the browser headers it needs", () => {
  const opts = liveSocketOptions(inst, { sentinel: true });
  const headers = opts.extraHeaders as Record<string, string>;
  assert.equal(headers.Origin, "https://pager.example");
});

test("builds a SOCKS5 agent without dialling anything", async () => {
  const agent = await proxyAgentFor("socks5://127.0.0.1:1080");
  assert.ok(agent, "expected an agent instance");
  assert.equal(typeof (agent as { addRequest?: unknown }).addRequest, "function");
});

test("rejects a proxy URL it can't honour, by name", async () => {
  // The tunnel this was built for is `ssh -N -R 1080`, which speaks SOCKS. An
  // http:// proxy would be silently ignored by socks-proxy-agent, and a source
  // that quietly connects direct is one that quietly 403s forever.
  await assert.rejects(() => proxyAgentFor("http://127.0.0.1:3128"), /socks/i);
});

// --- wiring an instance to its proxy, from the environment --------------------
//
// Read at call time rather than at import: feeder/index.ts loads .env.local in
// its own module body, and ES imports are evaluated before that runs, so
// anything reading process.env at module scope would see an empty environment.

test("an instance with no proxy env var is passed through untouched", () => {
  const out = withEnv("FEEDER_PROXY_TEST", undefined, () => withProxy(inst));
  assert.equal(out, inst, "expected the very same object, not a copy");
});

test("the proxy env var names the instance it applies to", () => {
  const out = withEnv("FEEDER_PROXY_TEST", "socks5://127.0.0.1:1080", () => withProxy(inst));
  assert.equal(out.proxy, "socks5://127.0.0.1:1080");
  assert.equal(inst.proxy, undefined, "the table's own entry must not be mutated");
});

test("a hyphenated label maps to an env var that a shell can actually set", () => {
  const feed: LiveInstance = { label: "pager-feed", baseUrl: "https://pager-feed.net" };
  const out = withEnv("FEEDER_PROXY_PAGER_FEED", "socks5://127.0.0.1:1080", () => withProxy(feed));
  assert.equal(out.proxy, "socks5://127.0.0.1:1080");
});

test("giving an unreachable host a route is what switches it back on", () => {
  const blocked: LiveInstance = {
    label: "test",
    baseUrl: "https://pager.example",
    disabled: "Cloudflare 403s this host's IP",
  };
  const off = withEnv("FEEDER_PROXY_TEST", undefined, () => withProxy(blocked));
  assert.equal(typeof off.disabled, "string", "no route means it stays off");

  const on = withEnv("FEEDER_PROXY_TEST", "socks5://127.0.0.1:1080", () => withProxy(blocked));
  assert.equal(on.disabled, undefined, "a route means the reason it was off is gone");
});

test("blank or whitespace-only is treated as unset, not as a proxy URL", () => {
  const out = withEnv("FEEDER_PROXY_TEST", "   ", () => withProxy(inst));
  assert.equal(out.proxy, undefined);
});

test("the forcequit entry is the one wired to a proxy, and is off without one", () => {
  const forcequit = PUBLIC_INSTANCES.find((i) => i.label === "forcequit");
  assert.ok(forcequit, "forcequit should still be in the table");
  const off = withEnv("FEEDER_PROXY_FORCEQUIT", undefined, () => withProxy(forcequit));
  assert.match(off.disabled ?? "", /FEEDER_PROXY_FORCEQUIT/, "the log line should say how to turn it on");
  const on = withEnv("FEEDER_PROXY_FORCEQUIT", "socks5://127.0.0.1:1080", () => withProxy(forcequit));
  assert.equal(on.disabled, undefined);
  assert.equal(on.proxy, "socks5://127.0.0.1:1080");
});
