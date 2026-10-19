import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DriveClient,
  MAX_ARTIFACT_BYTES,
  type DriveFile,
} from "../lib/drive.ts";
import { type DriveConfig, safeDriveError } from "../lib/drive-config.ts";

const config: DriveConfig = {
  schemaVersion: 1,
  infisical: {
    configDir: "/unused",
    environment: "dev",
    path: "/pi-google-drive",
  },
  folders: {
    Projects: { id: "projects", write: true },
    Templates: { id: "templates", write: false },
    Architecture: { id: "architecture", write: false },
  },
};
function fixture() {
  const files = new Map<string, DriveFile>([
    ...["projects", "templates", "architecture"].map(
      (id) =>
        [
          id,
          {
            id,
            name: id,
            mimeType: "application/vnd.google-apps.folder",
            capabilities: { canEdit: true, canAddChildren: true },
          },
        ] as [string, DriveFile],
    ),
    [
      "child",
      {
        id: "child",
        name: "child",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["projects"],
      },
    ],
    [
      "file",
      {
        id: "file",
        name: "example.md",
        mimeType: "text/markdown",
        parents: ["child"],
        capabilities: { canEdit: true },
      },
    ],
    [
      "doc",
      {
        id: "doc",
        name: "Example",
        mimeType: "application/vnd.google-apps.document",
        parents: ["projects"],
        capabilities: { canEdit: true },
      },
    ],
  ]);
  const calls: { url: URL; init: RequestInit }[] = [];
  let etag: string | undefined = '"revision-1"';
  let patchStatus = 200;
  let duplicate = false;
  let invalidations = 0;
  const transport = (async (
    url: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init });
    assert.ok(
      ["www.googleapis.com", "docs.googleapis.com"].includes(parsed.hostname),
    );
    if (parsed.hostname === "docs.googleapis.com")
      return init.method === "POST"
        ? Response.json(
            patchStatus === 400
              ? { error: { message: "required revision is not current" } }
              : { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] },
            { status: patchStatus },
          )
        : Response.json({
            revisionId: "doc-revision",
            body: { content: "Original" },
          });
    if (init.method === "POST" || init.method === "PATCH")
      return Response.json(
        { id: "created", name: "artifact.json", mimeType: "application/json" },
        { status: patchStatus },
      );
    if (parsed.pathname === "/drive/v3/files")
      return Response.json({
        files: duplicate ? [{ id: "file", name: "example.md" }] : [],
        nextPageToken: "next",
      });
    const id = parsed.pathname.split("/").at(-1)!;
    if (parsed.searchParams.get("alt") === "media")
      return new Response("# Existing document");
    const file = files.get(id);
    return file
      ? Response.json(file, { headers: etag ? { ETag: etag } : {} })
      : Response.json({}, { status: 404 });
  }) as typeof fetch;
  const client = new DriveClient(
    config,
    {
      access: async (grant) => `${grant}-token`,
      invalidate: () => {
        invalidations++;
      },
    },
    transport,
  );
  return {
    files,
    calls,
    client,
    setEtag: (value?: string) => {
      etag = value;
    },
    setStatus: (value: number) => {
      patchStatus = value;
    },
    setDuplicate: () => {
      duplicate = true;
    },
    invalidations: () => invalidations,
  };
}

test("existing documents resolve nested approved ancestors and include source and concurrency metadata", async () => {
  const f = fixture();
  const result = await f.client.get("Projects", "file");
  assert.equal(result.etag, '"revision-1"');
  assert.ok("content" in result);
  assert.equal(result.content, "# Existing document");
  assert.match(result.source, /file\/d\/file/);
  assert.ok(
    f.calls.every(
      (call) =>
        (call.init.headers as Record<string, string>).Authorization ===
        "Bearer read-token",
    ),
  );
  const native = await f.client.get("Projects", "doc");
  assert.ok("document" in native);
  assert.equal(native.document.revisionId, "doc-revision");
});

test("unapproved locations, shortcuts, trash, cycles and invalid IDs never retrieve file content", async () => {
  for (const change of [
    { parents: ["templates"] },
    { shortcutDetails: { targetId: "outside" } },
    { trashed: true },
    { parents: ["file"] },
    { parents: [] },
  ]) {
    const f = fixture();
    Object.assign(f.files.get("file")!, change);
    await assert.rejects(f.client.get("Projects", "file"));
    assert.equal(
      f.calls.some((call) => call.url.searchParams.get("alt") === "media"),
      false,
    );
  }
  const f = fixture();
  await assert.rejects(f.client.get("Projects", "../outside"), {
    code: "INVALID_ID",
  });
  await assert.rejects(
    f.client.create("Templates", "x", Buffer.from("x"), "text/plain"),
    { code: "DESTINATION_NOT_APPROVED" },
  );
  assert.equal(f.calls.length, 0);
});

test("search is folder restricted, escapes query text, supports pagination and nested folders", async () => {
  const f = fixture();
  const result = await f.client.search(
    "Projects",
    "a' or trashed = true",
    "page",
    "child",
  );
  const call = f.calls.find((call) => call.url.pathname === "/drive/v3/files")!;
  assert.match(
    call.url.searchParams.get("q")!,
    /^'child' in parents and trashed = false/,
  );
  assert.ok(call.url.searchParams.get("q")!.includes("a\\' or trashed = true"));
  assert.equal(call.url.searchParams.get("pageToken"), "page");
  assert.equal(result.nextPageToken, "next");
  await assert.rejects(
    f.client.search("Projects", "", undefined, "templates"),
    { code: "OUTSIDE_APPROVED_LOCATION" },
  );
});

test("create and binary uploads use approved parents, write grant and POST; duplicate names refuse writes", async () => {
  const f = fixture();
  const bytes = Buffer.from([0, 1, 2, 128, 255]);
  await f.client.create("Projects", "artifact.pdf", bytes, "application/pdf");
  const call = f.calls.find((call) => call.init.method === "POST")!;
  assert.equal(
    (call.init.headers as Record<string, string>).Authorization,
    "Bearer write-token",
  );
  const body = call.init.body as Buffer;
  assert.ok(body.includes(bytes));
  assert.match(body.toString(), /"parents":\["projects"\]/);
  assert.match(body.toString(), /Content-Type: application\/pdf/);
  f.setDuplicate();
  await assert.rejects(
    f.client.create(
      "Projects",
      "existing.md",
      Buffer.from("text"),
      "text/markdown",
    ),
    { code: "NAME_EXISTS" },
  );
  assert.equal(f.calls.filter((call) => call.init.method === "POST").length, 1);
});

test("native Docs creation converts text and updates preserve structure with requiredRevisionId", async () => {
  const f = fixture();
  await f.client.create(
    "Projects",
    "Disposable",
    Buffer.from("Original"),
    "text/plain",
    true,
  );
  const create = f.calls.find((call) => call.init.method === "POST")!;
  assert.match(
    (create.init.body as Buffer).toString(),
    /application\/vnd.google-apps.document/,
  );
  await f.client.updateDocument(
    "Projects",
    "doc",
    "doc-revision",
    "Original",
    "Updated",
  );
  const update = f.calls.at(-1)!;
  const body = JSON.parse(update.init.body as string);
  assert.deepEqual(body.writeControl, { requiredRevisionId: "doc-revision" });
  assert.deepEqual(body.requests, [
    {
      replaceAllText: {
        containsText: { text: "Original", matchCase: true },
        replaceText: "Updated",
      },
    },
  ]);
  f.setStatus(400);
  await assert.rejects(
    f.client.updateDocument("Projects", "doc", "stale", "Original", "Updated"),
    { code: "REVISION_CONFLICT" },
  );
});

test("blob updates require exact strong ETags and enforce server-side If-Match against races", async () => {
  const f = fixture();
  const update = (etag: string) =>
    f.client.update(
      "Projects",
      "file",
      etag,
      Buffer.from("updated"),
      "text/markdown",
    );
  await assert.rejects(update("*"), { code: "REVISION_REQUIRED" });
  await assert.rejects(update('"old"'), { code: "REVISION_CONFLICT" });
  f.setEtag();
  await assert.rejects(update('"revision-1"'), {
    code: "CONDITIONAL_UPDATE_UNAVAILABLE",
  });
  f.setEtag('"revision-1"');
  await update('"revision-1"');
  assert.equal(
    (f.calls.at(-1)!.init.headers as Record<string, string>)["If-Match"],
    '"revision-1"',
  );
  f.setStatus(412);
  await assert.rejects(update('"revision-1"'), { code: "REVISION_CONFLICT" });
  assert.equal(
    f.calls.filter((call) => call.init.method === "PATCH").length,
    2,
  );
});

test("artifact validation rejects credentials, oversized data, invalid MIME types and path names before writes", async () => {
  const f = fixture();
  for (const content of [
    '{"refresh_token":"secret"}',
    "GOCSPX-test-fixture",
    "ya29.test-fixture",
  ])
    await assert.rejects(
      f.client.create(
        "Projects",
        "secret.json",
        Buffer.from(content),
        "application/json",
      ),
      { code: "CREDENTIAL_CONTENT" },
    );
  await assert.rejects(
    f.client.create(
      "Projects",
      "large",
      Buffer.alloc(MAX_ARTIFACT_BYTES + 1),
      "application/pdf",
    ),
    { code: "FILE_TOO_LARGE" },
  );
  await assert.rejects(
    f.client.create("Projects", "../name", Buffer.from("text"), "text/plain"),
    { code: "INVALID_FILENAME" },
  );
  await assert.rejects(
    f.client.create(
      "Projects",
      "name",
      Buffer.from("text"),
      "text/plain\r\nInjected: yes",
    ),
    { code: "INVALID_MIME_TYPE" },
  );
  assert.equal(f.calls.length, 0);
});

test("401 refreshes once, while server errors never replay mutation and never expose raw error data", async () => {
  let calls = 0;
  let invalidations = 0;
  const tokens = {
    access: async () => "private-token",
    invalidate: () => {
      invalidations++;
    },
  };
  const retry = new DriveClient(config, tokens, (async () => {
    calls++;
    return Response.json({ secret: "private-token" }, { status: 401 });
  }) as typeof fetch);
  await assert.rejects(retry.metadata("file"), { code: "CONSENT_REQUIRED" });
  assert.equal(calls, 2);
  assert.equal(invalidations, 1);
  for (const [status, code] of [
    [403, "PERMISSION_DENIED"],
    [404, "FILE_UNAVAILABLE"],
    [429, "RATE_LIMITED"],
    [503, "DRIVE_API_ERROR"],
  ] as const) {
    const failed = new DriveClient(config, tokens, (async () =>
      Response.json(
        { error: { message: "private-token" } },
        { status },
      )) as typeof fetch);
    await assert.rejects(failed.metadata("file"), (error) => {
      const safe = safeDriveError(error);
      assert.equal(safe.code, code);
      assert.doesNotMatch(JSON.stringify(safe), /private-token/);
      return true;
    });
  }
  const f = fixture();
  f.setStatus(503);
  await assert.rejects(
    f.client.create("Projects", "new.md", Buffer.from("x"), "text/markdown"),
    { code: "DRIVE_API_ERROR" },
  );
  assert.equal(f.calls.filter((call) => call.init.method === "POST").length, 1);
});
