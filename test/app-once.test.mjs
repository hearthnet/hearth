// The web app's check cache (app/once.mjs): the Hosts page asks each host's
// sponsor and reads its chains once per five minutes, not on every visit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "../app/once.mjs";

const counter = (value = "ok") => { const f = async () => { f.calls++; return value; }; f.calls = 0; return f; };

test("a check runs once, and asks while it runs share it", async () => {
  const keep = once(), check = counter();
  assert.deepEqual(await Promise.all([keep("h", check), keep("h", check)]), ["ok", "ok"]);
  assert.equal(await keep("h", check), "ok");
  assert.equal(check.calls, 1);
  await keep("other", check);
  assert.equal(check.calls, 2, "another key is another check");
});

test("a kept answer runs again after its time", async () => {
  let t = 0;
  const keep = once({ ttl: 1000, now: () => t }), check = counter();
  await keep("h", check);
  t = 999; await keep("h", check);
  assert.equal(check.calls, 1);
  t = 1000; await keep("h", check);
  assert.equal(check.calls, 2);
});

test("a check that throws, or whose view went away, is not kept", async () => {
  const keep = once();
  await assert.rejects(keep("h", async () => { throw new Error("down"); }), /down/);
  const check = counter();
  await keep("h", check);
  assert.equal(check.calls, 1, "the failure was not kept");

  const view = new AbortController(), slow = counter("half read");
  const asked = keep("s", slow, view.signal);
  view.abort();
  assert.equal(await asked, "half read");
  const fresh = counter("whole");
  assert.equal(await keep("s", fresh), "whole", "an aborted view's answer is dropped");
});

test("a finished answer outlives the view that asked for it", async () => {
  const keep = once(), view = new AbortController(), check = counter();
  await keep("h", check, view.signal);
  view.abort();
  await keep("h", check);
  assert.equal(check.calls, 1);
});
