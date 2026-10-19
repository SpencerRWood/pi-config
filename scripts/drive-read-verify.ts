import { DriveClient } from "../lib/drive.ts";
import { DriveTokens, InfisicalDriveSecrets } from "../lib/drive-auth.ts";
import {
  DriveError,
  loadDriveConfig,
  safeDriveError,
  folderNames,
  type FolderName,
} from "../lib/drive-config.ts";

try {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  const folder = process.env.WOOD_PI_DRIVE_VERIFY_FOLDER as FolderName;
  const id = process.env.WOOD_PI_DRIVE_VERIFY_FILE_ID;
  if (!id || !folderNames.includes(folder))
    throw new DriveError(
      "VERIFICATION_INPUT_REQUIRED",
      "Set PI_CODING_AGENT_DIR, WOOD_PI_DRIVE_VERIFY_FOLDER and WOOD_PI_DRIVE_VERIFY_FILE_ID to an approved existing source document.",
    );
  const config = loadDriveConfig(agentDir);
  const drive = new DriveClient(
    config,
    new DriveTokens(new InfisicalDriveSecrets(config.infisical)),
  );
  const result = await drive.get(folder, id);
  if (result.file.mimeType === "application/vnd.google-apps.folder")
    throw new DriveError(
      "SOURCE_DOCUMENT_REQUIRED",
      "Verification requires an existing document, not a folder.",
    );
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      operation: "read-existing-document",
      observedAt: new Date().toISOString(),
      folder,
      fileId: result.file.id,
      source: result.source,
    }) + "\n",
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({ status: "failed", ...safeDriveError(error) }) + "\n",
  );
  process.exitCode = 1;
}
