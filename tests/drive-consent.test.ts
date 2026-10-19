import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { consent } from "../lib/drive-consent.ts";
import { READ_SCOPE } from "../lib/drive-config.ts";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("loopback consent validates state, PKCE, exact scope and account before storing only refresh token", async () => {
  const stored: [string, string][] = [];
  const port = await freePort();
  let challenge = "";
  const result = await consent({
    port,
    clientType: "desktop",
    account: "fixture@example.com",
    grant: "read",
    timeoutMs: 5000,
    secrets: {
      get: async (name) =>
        name.endsWith("ID") ? "client-id-fixture" : "client-secret-fixture",
      set: async (key, value) => {
        stored.push([key, value]);
      },
    },
    openBrowser: async (address) => {
      const url = new URL(address);
      assert.equal(url.origin, "https://accounts.google.com");
      assert.equal(url.searchParams.get("scope"), READ_SCOPE);
      assert.equal(url.searchParams.get("include_granted_scopes"), "false");
      assert.equal(url.searchParams.get("access_type"), "offline");
      assert.equal(url.searchParams.has("client_secret"), false);
      assert.equal(url.searchParams.has("code_verifier"), false);
      assert.equal(url.searchParams.has("code"), false);
      assert.equal(url.searchParams.has("access_token"), false);
      assert.equal(url.searchParams.has("refresh_token"), false);
      challenge = url.searchParams.get("code_challenge")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({
        state: "é".repeat(43),
        code: "bad-code",
      }).toString();
      assert.equal((await fetch(callback)).status, 400);
      callback.search = new URLSearchParams({
        state: url.searchParams.get("state")!,
        code: "test-code",
      }).toString();
      assert.equal((await fetch(callback)).status, 200);
    },
    transport: (async (url, init) => {
      if (String(url).includes("/token")) {
        const body = init!.body as URLSearchParams;
        assert.equal(body.get("code"), "test-code");
        assert.equal(
          createHash("sha256")
            .update(body.get("code_verifier")!)
            .digest("base64url"),
          challenge,
        );
        assert.equal(body.get("client_secret"), "client-secret-fixture");
        return Response.json({
          access_token: "test-access",
          refresh_token: "test-refresh",
          scope: READ_SCOPE,
          expires_in: 3600,
        });
      }
      return Response.json({ user: { emailAddress: "fixture@example.com" } });
    }) as typeof fetch,
  });
  assert.equal(result.stored, true);
  assert.deepEqual(stored, [
    ["GOOGLE_DRIVE_READ_REFRESH_TOKEN", "test-refresh"],
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /test-refresh|test-access|client-secret-fixture/,
  );
});

test("wrong account, broader scope and denied consent never write credentials", async () => {
  for (const failure of ["account", "scope", "denied"]) {
    let writes = 0;
    await assert.rejects(
      consent({
        port: await freePort(),
        clientType: "web",
        account: "expected@example.com",
        grant: "read",
        timeoutMs: 5000,
        secrets: {
          get: async () => "test-client",
          set: async () => {
            writes++;
          },
        },
        openBrowser: async (address) => {
          const url = new URL(address);
          const callback = new URL(url.searchParams.get("redirect_uri")!);
          callback.searchParams.set("state", url.searchParams.get("state")!);
          callback.searchParams.set(
            failure === "denied" ? "error" : "code",
            failure === "denied" ? "access_denied" : "test-code",
          );
          await fetch(callback);
        },
        transport: (async (url) =>
          String(url).includes("/token")
            ? Response.json({
                access_token: "access",
                refresh_token: "refresh",
                expires_in: 3600,
                scope:
                  failure === "scope" ? `${READ_SCOPE} broader` : READ_SCOPE,
              })
            : Response.json({
                user: { emailAddress: "wrong@example.com" },
              })) as typeof fetch,
      }),
      {
        code:
          failure === "account"
            ? "ACCOUNT_MISMATCH"
            : failure === "scope"
              ? "SCOPE_MISMATCH"
              : "CONSENT_DENIED",
      },
    );
    assert.equal(writes, 0);
  }
});

test("consent timeout closes the callback listener without storing credentials", async () => {
  let writes = 0;
  await assert.rejects(
    consent({
      port: await freePort(),
      grant: "read",
      clientType: "desktop",
      account: "fixture@example.com",
      timeoutMs: 20,
      secrets: {
        get: async () => "fixture",
        set: async () => {
          writes++;
        },
      },
      openBrowser: async () => {},
    }),
    { code: "CONSENT_TIMEOUT" },
  );
  assert.equal(writes, 0);
});
