import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  loadDriveConfig,
  safeDriveError,
  folderNames,
  type FolderName,
} from "../lib/drive-config.ts";
import { DriveTokens, InfisicalDriveSecrets } from "../lib/drive-auth.ts";
import { DriveClient } from "../lib/drive.ts";

const created: { operation: string; id: string }[] = [];
const planned: string[] = [];
try {
  const { values } = parseArgs({
    options: {
      "agent-dir": { type: "string" },
      folder: { type: "string" },
      "existing-id": { type: "string" },
      "create-disposable-files": { type: "boolean", default: false },
    },
  });
  if (
    !values["agent-dir"] ||
    !folderNames.includes(values.folder as FolderName) ||
    !values["existing-id"] ||
    !values["create-disposable-files"]
  )
    throw new Error();
  const folder = values.folder as FolderName;
  const config = loadDriveConfig(values["agent-dir"]);
  const drive = new DriveClient(
    config,
    new DriveTokens(new InfisicalDriveSecrets(config.infisical)),
  );
  const source = await drive.get(folder, values["existing-id"]);
  if (source.file.mimeType === "application/vnd.google-apps.folder")
    throw new Error();
  const marker = `OP536-${randomUUID()}`;
  planned.push(
    `${marker}-disposable-doc`,
    `${marker}-disposable-artifact.json`,
  );
  const document = await drive.create(
    folder,
    `${marker}-disposable-doc`,
    Buffer.from(marker),
    "text/plain",
    true,
  );
  created.push({ operation: "create-document", id: document.id });
  const before = await drive.get(folder, document.id);
  if (!("document" in before) || !before.document.revisionId) throw new Error();
  const update = (await drive.updateDocument(
    folder,
    document.id,
    before.document.revisionId,
    marker,
    `${marker}-updated`,
  )) as { replies?: { replaceAllText?: { occurrencesChanged?: number } }[] };
  if (update.replies?.[0]?.replaceAllText?.occurrencesChanged !== 1)
    throw new Error();
  const after = await drive.get(folder, document.id);
  if (
    !("document" in after) ||
    !JSON.stringify(after.document).includes(`${marker}-updated`)
  )
    throw new Error();
  const artifact = Buffer.from(
    JSON.stringify({ story: 536, disposable: true, marker }),
  );
  const upload = await drive.create(
    folder,
    `${marker}-disposable-artifact.json`,
    artifact,
    "application/json",
  );
  created.push({ operation: "upload-json", id: upload.id });
  const retrieved = await drive.get(folder, upload.id);
  if (!("content" in retrieved) || retrieved.content !== artifact.toString())
    throw new Error();
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      observedAt: new Date().toISOString(),
      folder,
      sourceId: source.file.id,
      checks: [
        "read-existing",
        "create",
        "read-created",
        "revision-protected-update",
        "read-updated",
        "upload",
        "read-uploaded",
      ],
      created,
      cleanup:
        "Disposable files retained. Deletion requires separate explicit authorization.",
    }) + "\n",
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      status: "failed",
      ...safeDriveError(error),
      created,
      planned,
      nextAction:
        "Resolve the error before retrying. Inspect retained disposable IDs; partial writes are not rolled back automatically.",
      usage:
        "node --import tsx scripts/drive-verify.ts --agent-dir ABSOLUTE_PATH --folder Projects|Templates|Architecture --existing-id FILE_ID --create-disposable-files",
    }) + "\n",
  );
  process.exitCode = 1;
}
