import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT } from "jose";

// server-only imports require: node --conditions=react-server --import tsx --test lib/access.test.ts
// All credentials are synthetic and both the transport and query layer are stubbed.
test("device authentication and API authorization regressions", async (t) => {
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET"] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  const originalFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-test-service-key";
  process.env.SUPABASE_JWT_SECRET = "local-only-test-secret-32-characters-minimum";
  globalThis.fetch = async () => { throw new Error("Network access is forbidden in authentication tests"); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { mintAccessToken, verifyAccessToken } = await import("./access");
  const { supabase } = await import("./supabase");
  const originalFrom = supabase.from;
  let active = true;
  let databaseError = false;
  let queryCount = 0;
  supabase.from = (() => {
    queryCount++;
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      maybeSingle: async () => ({
        data: active ? { id: "device-id" } : null,
        error: databaseError ? { code: "test-database-error" } : null,
      }),
    };
    return query;
  }) as unknown as typeof supabase.from;
  t.after(() => { supabase.from = originalFrom; });

  await t.test("missing signing secret fails closed", async () => {
    const secret = process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    await assert.rejects(mintAccessToken("device-id"));
    assert.equal(await verifyAccessToken("invalid"), null);
    process.env.SUPABASE_JWT_SECRET = secret;
  });
  const valid = await mintAccessToken("device-id");
  await t.test("malformed token is refused", async () => {
    assert.equal(await verifyAccessToken("invalid"), null);
  });
  await t.test("active device is accepted", async () => {
    assert.equal(await verifyAccessToken(valid), "device-id");
  });
  await t.test("revoked or missing device is refused", async () => {
    active = false;
    assert.equal(await verifyAccessToken(valid), null);
    active = true;
  });
  await t.test("database failures fail closed", async () => {
    databaseError = true;
    assert.equal(await verifyAccessToken(valid), null);
    databaseError = false;
  });

  const key = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
  const claims = () => new SignJWT({ role: "authenticated" })
    .setSubject("device-id").setAudience("authenticated").setIssuedAt();
  await t.test("other signing algorithms are refused", async () => {
    const token = await claims().setProtectedHeader({ alg: "HS384" }).setExpirationTime("1h").sign(key);
    assert.equal(await verifyAccessToken(token), null);
  });
  await t.test("tokens without expiry are refused", async () => {
    const token = await claims().setProtectedHeader({ alg: "HS256" }).sign(key);
    assert.equal(await verifyAccessToken(token), null);
  });
  await t.test("expired tokens are refused", async () => {
    const token = await claims().setProtectedHeader({ alg: "HS256" }).setExpirationTime(1).sign(key);
    assert.equal(await verifyAccessToken(token), null);
  });

  const incidents = await import("../app/api/incidents/route");
  for (const method of ["POST", "DELETE"] as const) {
    await t.test(`${method} refuses anonymous and enrolled non-admin callers before database access`, async () => {
      const beforeQueries = queryCount;
      for (const token of [null, valid]) {
        const response = await incidents[method](new Request("http://localhost/api/incidents", {
          method,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }));
        assert.equal(response.status, 401);
      }
      assert.equal(queryCount, beforeQueries);
    });
  }
});
