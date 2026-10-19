import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DriveTokens,
  tokenRequest,
  type SecretStore,
} from "../lib/drive-auth.ts";
import {
  READ_SCOPE,
  WRITE_SCOPE,
  safeDriveError,
} from "../lib/drive-config.ts";

function secrets() {
  const values = new Map<string, string>([
    ["GOOGLE_DRIVE_CLIENT_ID", "test-client"],
    ["GOOGLE_DRIVE_CLIENT_SECRET", "test-secret"],
    ["GOOGLE_DRIVE_READ_REFRESH_TOKEN", "test-read-refresh"],
    ["GOOGLE_DRIVE_WRITE_REFRESH_TOKEN", "test-write-refresh"],
  ]);
  return {
    values,
    async get(key: string) {
      assert.ok(values.has(key));
      return values.get(key)!;
    },
    async set(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies SecretStore & { values: Map<string, string> };
}

test("concurrent refresh is shared, scopes stay separate, rotation persists, and 401 invalidates cache", async () => {
  const store = secrets();
  const calls: URLSearchParams[] = [];
  const transport = (async (_url, init) => {
    const body = init!.body as URLSearchParams;
    calls.push(body);
    const read = body.get("refresh_token")!.includes("read");
    await Promise.resolve();
    return Response.json({
      access_token: read ? "read-access" : "write-access",
      expires_in: 3600,
      refresh_token: read ? "read-rotated" : "write-rotated",
      scope: read ? READ_SCOPE : WRITE_SCOPE,
    });
  }) as typeof fetch;
  const tokens = new DriveTokens(store, transport);
  assert.deepEqual(
    await Promise.all([tokens.access("read"), tokens.access("read")]),
    ["read-access", "read-access"],
  );
  assert.equal(calls.length, 1);
  assert.equal(await tokens.access("read"), "read-access");
  assert.equal(calls.length, 1);
  assert.equal(
    store.values.get("GOOGLE_DRIVE_READ_REFRESH_TOKEN"),
    "read-rotated",
  );
  assert.equal(await tokens.access("write"), "write-access");
  assert.equal(calls[1].get("refresh_token"), "test-write-refresh");
  tokens.invalidate("read");
  await tokens.access("read");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].get("refresh_token"), "read-rotated");
});

test("expired tokens refresh and broader or wrong grants are refused", async () => {
  let calls = 0;
  const tokens = new DriveTokens(secrets(), (async () => {
    calls++;
    return Response.json({
      access_token: "short-lived",
      expires_in: 1,
      scope: READ_SCOPE,
    });
  }) as typeof fetch);
  await tokens.access("read");
  await tokens.access("read");
  assert.equal(calls, 2);
  for (const scope of [
    undefined,
    WRITE_SCOPE,
    `${READ_SCOPE} ${WRITE_SCOPE}`,
  ]) {
    const wrong = new DriveTokens(secrets(), (async () =>
      Response.json({
        access_token: "access",
        expires_in: 3600,
        scope,
      })) as typeof fetch);
    await assert.rejects(wrong.access("read"), { code: "SCOPE_MISMATCH" });
  }
});

test("token diagnostics redact echoed secrets and distinguish recovery actions", async () => {
  for (const [error, code] of [
    ["invalid_grant", "CONSENT_REQUIRED"],
    ["invalid_client", "OAUTH_CLIENT_INVALID"],
    ["other", "AUTHENTICATION_FAILED"],
  ]) {
    await assert.rejects(
      tokenRequest(new URLSearchParams(), (async () =>
        Response.json(
          { error, error_description: "test-secret test-read-refresh" },
          { status: 400 },
        )) as typeof fetch),
      (failure: unknown) => {
        const safe = safeDriveError(failure);
        assert.equal(safe.code, code);
        assert.doesNotMatch(
          JSON.stringify(safe),
          /test-secret|test-read-refresh/,
        );
        return true;
      },
    );
  }
  await assert.rejects(
    tokenRequest(new URLSearchParams(), (async () => {
      throw new Error("leaked-secret");
    }) as typeof fetch),
    { code: "AUTH_NETWORK_ERROR" },
  );
  assert.doesNotMatch(
    JSON.stringify(safeDriveError(new Error("leaked-secret"))),
    /leaked-secret/,
  );
  await assert.rejects(
    tokenRequest(new URLSearchParams(), (async () =>
      Response.json({
        access_token: "access",
        expires_in: -1,
      })) as typeof fetch),
    { code: "AUTH_RESPONSE_INVALID" },
  );
  for (const response of [null, [], { access_token: "", expires_in: 3600 }]) {
    await assert.rejects(
      tokenRequest(new URLSearchParams(), (async () =>
        Response.json(response)) as typeof fetch),
      { code: "AUTH_RESPONSE_INVALID" },
    );
  }
});
