import { randomUUID } from "node:crypto";
import { DriveTokens } from "./drive-auth.ts";
import {
  DriveError,
  driveId,
  type DriveConfig,
  type FolderName,
  type Grant,
} from "./drive-config.ts";

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
const fields =
  "id,name,mimeType,parents,trashed,version,webViewLink,capabilities(canEdit,canAddChildren),shortcutDetails";
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  version?: string;
  webViewLink?: string;
  capabilities?: { canEdit?: boolean; canAddChildren?: boolean };
  shortcutDetails?: unknown;
}
export interface Observation {
  file: DriveFile;
  etag?: string;
}
const quote = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

export class DriveClient {
  constructor(
    readonly config: DriveConfig,
    private readonly tokens: Pick<DriveTokens, "access" | "invalidate">,
    private readonly transport: typeof fetch = fetch,
  ) {}
  private async request(
    path: string,
    grant: Grant = "read",
    init: RequestInit = {},
    retry = true,
  ): Promise<Response> {
    const token = await this.tokens.access(grant);
    let response: Response;
    try {
      const endpoint = path.startsWith("docs/")
        ? `https://docs.googleapis.com/${path.slice(5)}`
        : `https://www.googleapis.com/${path}`;
      response = await this.transport(endpoint, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new DriveError(
        "API_NETWORK_ERROR",
        init.method && init.method !== "GET"
          ? "Drive response was lost. The write outcome is unknown; inspect the destination before retrying."
          : "Drive is unreachable; check network connectivity.",
      );
    }
    if (response.status === 401 && retry) {
      this.tokens.invalidate(grant);
      return this.request(path, grant, init, false);
    }
    if (!response.ok) {
      let reason = "";
      let revisionConflict = false;
      try {
        const detail = (await response.json()) as {
          error?: { message?: string; errors?: { reason?: string }[] };
        };
        reason = detail.error?.errors?.[0]?.reason ?? "";
        revisionConflict =
          response.status === 400 &&
          /revision/i.test(detail.error?.message ?? "");
      } catch {
        /* HTTP status remains authoritative when the error body is invalid. */
      }
      if (revisionConflict)
        throw new DriveError(
          "REVISION_CONFLICT",
          "Google rejected the required revision. Retrieve and reconcile the current document before updating.",
          response.status,
        );
      if (
        [
          "rateLimitExceeded",
          "userRateLimitExceeded",
          "dailyLimitExceeded",
          "storageQuotaExceeded",
        ].includes(reason)
      )
        throw new DriveError(
          "QUOTA_EXCEEDED",
          "Google quota or storage limit exceeded. Resolve the quota or wait before retrying; inspect write outcomes first.",
          response.status,
        );
      if (reason === "accessNotConfigured")
        throw new DriveError(
          "API_NOT_ENABLED",
          "Enable the Google Drive API and, for native documents, the Google Docs API in the OAuth client project.",
          response.status,
        );
      const errors: Record<number, [string, string]> = {
        400: [
          "INVALID_REQUEST",
          "Drive rejected the request; check file type, fields and enabled APIs.",
        ],
        401: [
          "CONSENT_REQUIRED",
          "Drive rejected the refreshed grant. Renew Google consent.",
        ],
        403: [
          "PERMISSION_DENIED",
          "Drive denied access. Check account permissions, enabled APIs, OAuth scopes, organization policy and quota. A drive.file grant only covers app-authorized files.",
        ],
        404: [
          "FILE_UNAVAILABLE",
          "File was not found or is not accessible to this account and OAuth grant.",
        ],
        409: [
          "CONFLICT",
          "Drive reported a conflict; retrieve the current file before retrying.",
        ],
        412: [
          "REVISION_CONFLICT",
          "File changed since retrieval. Read the current revision and reconcile before updating.",
        ],
        429: [
          "RATE_LIMITED",
          "Drive rate limit exceeded; wait before retrying. Writes are never automatically replayed for quota or server errors.",
        ],
      };
      const [code, message] = errors[response.status] ?? [
        "DRIVE_API_ERROR",
        "Drive API failed; check Google service health and retry reads later. Inspect write outcomes before retrying.",
      ];
      // Do not return raw API bodies: they may echo request text or credentials.
      throw new DriveError(code, message, response.status);
    }
    return response;
  }
  private async json<T>(
    path: string,
    grant: Grant = "read",
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.request(path, grant, init);
    try {
      return JSON.parse(
        (await this.readLimited(response)).toString("utf8"),
      ) as T;
    } catch (error) {
      if (error instanceof DriveError) throw error;
      throw new DriveError(
        "API_RESPONSE_INVALID",
        "Drive returned invalid JSON; inspect the destination before retrying writes.",
      );
    }
  }
  async metadata(id: string): Promise<Observation> {
    const response = await this.request(
      `drive/v3/files/${driveId(id)}?${new URLSearchParams({ fields, supportsAllDrives: "true" })}`,
    );
    let file: DriveFile;
    try {
      file = (await response.json()) as DriveFile;
    } catch {
      throw new DriveError(
        "API_RESPONSE_INVALID",
        "Drive returned invalid file metadata.",
      );
    }
    if (
      file.id !== id ||
      typeof file.name !== "string" ||
      typeof file.mimeType !== "string"
    )
      throw new DriveError(
        "API_RESPONSE_INVALID",
        "Drive returned incomplete file metadata.",
      );
    if (
      file.trashed ||
      file.shortcutDetails ||
      file.mimeType === "application/vnd.google-apps.shortcut"
    )
      throw new DriveError(
        "FILE_UNAVAILABLE",
        "Trashed files and shortcuts are excluded from approved-location access.",
      );
    const etag = response.headers.get("etag") ?? undefined;
    return { file, ...(etag && /^"[^"\r\n]+"$/.test(etag) ? { etag } : {}) };
  }
  private folder(name: FolderName, write = false) {
    const folder = this.config.folders[name];
    if (!folder || (write && !folder.write))
      throw new DriveError(
        "DESTINATION_NOT_APPROVED",
        "This folder is not configured for the requested operation.",
      );
    return folder;
  }
  async authorizeFile(
    name: FolderName,
    id: string,
    write = false,
  ): Promise<Observation> {
    const approved = this.folder(name, write);
    const initial = await this.metadata(driveId(id));
    let current = initial;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current.file.id)) break;
      seen.add(current.file.id);
      if (current.file.id === approved.id) {
        if (current.file.mimeType !== FOLDER)
          throw new DriveError(
            "INVALID_APPROVED_FOLDER",
            "The configured destination is not a Drive folder.",
          );
        if (write && initial.file.capabilities?.canEdit !== true)
          throw new DriveError(
            "PERMISSION_DENIED",
            "The current account cannot edit this file.",
          );
        return initial;
      }
      if (current.file.parents?.length !== 1) break;
      current = await this.metadata(current.file.parents[0]);
    }
    throw new DriveError(
      "OUTSIDE_APPROVED_LOCATION",
      "File is outside the selected approved folder, or its ancestry could not be verified.",
    );
  }
  async search(
    name: FolderName,
    text = "",
    pageToken?: string,
    parentId?: string,
  ) {
    if (text.length > 512 || (pageToken && pageToken.length > 2048))
      throw new DriveError(
        "INVALID_REQUEST",
        "Search input exceeds the supported limit.",
      );
    const parent = parentId ?? this.folder(name).id;
    const observed = await this.authorizeFile(name, parent);
    if (observed.file.mimeType !== FOLDER)
      throw new DriveError("INVALID_PARENT", "Search parent must be a folder.");
    const query =
      `'${quote(parent)}' in parents and trashed = false` +
      (text
        ? ` and (name contains '${quote(text)}' or fullText contains '${quote(text)}')`
        : "");
    const result = await this.json<{
      files: DriveFile[];
      nextPageToken?: string;
      incompleteSearch?: boolean;
    }>(
      `drive/v3/files?${new URLSearchParams({
        q: query,
        fields: `files(${fields}),nextPageToken,incompleteSearch`,
        pageSize: "50",
        spaces: "drive",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      })}`,
    );
    // Exclude trash, shortcuts and results outside the queried direct parent.
    const files: DriveFile[] = [];
    for (const file of result.files) {
      if (
        !file.trashed &&
        !file.shortcutDetails &&
        file.mimeType !== "application/vnd.google-apps.shortcut" &&
        file.parents?.includes(parent)
      )
        files.push(file);
    }
    return {
      ...result,
      files,
      sourceFolder: parent,
      scope:
        "Direct children; use a returned child folder ID to search deeper. OAuth read grant may see more, but this tool is folder restricted.",
    };
  }
  async get(name: FolderName, id: string) {
    const observation = await this.authorizeFile(name, id);
    const { file } = observation;
    if (file.mimeType === FOLDER)
      return {
        ...observation,
        source:
          file.webViewLink ?? `https://drive.google.com/drive/folders/${id}`,
      };
    if (file.mimeType === DOC) {
      const document = await this.json<{
        revisionId: string;
        body?: unknown;
        tabs?: unknown;
      }>(`docs/v1/documents/${driveId(id)}?includeTabsContent=true`);
      await this.authorizeFile(name, id);
      return {
        ...observation,
        document,
        source: `https://docs.google.com/document/d/${id}/edit`,
      };
    }
    const exports: Record<string, string> = {
      "application/vnd.google-apps.spreadsheet":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.google-apps.presentation": "application/pdf",
      "application/vnd.google-apps.drawing": "application/pdf",
    };
    const mimeType = exports[file.mimeType] ?? file.mimeType;
    const path = exports[file.mimeType]
      ? `drive/v3/files/${driveId(id)}/export?${new URLSearchParams({ mimeType })}`
      : `drive/v3/files/${driveId(id)}?alt=media&supportsAllDrives=true`;
    const content = await this.readLimited(await this.request(path));
    await this.authorizeFile(name, id);
    const textual =
      mimeType.startsWith("text/") ||
      /(?:json|xml|javascript|yaml)/.test(mimeType);
    return {
      ...observation,
      mimeType,
      encoding: textual ? "utf8" : "base64",
      content: content.toString(textual ? "utf8" : "base64"),
      source: file.webViewLink ?? `https://drive.google.com/file/d/${id}/view`,
    };
  }
  private async readLimited(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ARTIFACT_BYTES)
          throw new DriveError(
            "FILE_TOO_LARGE",
            "File exceeds the 10 MiB integration limit.",
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }
  private validateContent(content: Buffer, mimeType: string) {
    if (content.length > MAX_ARTIFACT_BYTES)
      throw new DriveError(
        "FILE_TOO_LARGE",
        "Artifact exceeds the 10 MiB integration limit.",
      );
    if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mimeType))
      throw new DriveError(
        "INVALID_MIME_TYPE",
        "Supply a valid MIME type without parameters.",
      );
    if (
      /GOCSPX-|ya29\.|\"(?:client_secret|refresh_token|access_token)\"\s*:|GOOGLE_DRIVE_(?:CLIENT_SECRET|(?:READ|WRITE)_REFRESH_TOKEN)\s*=/.test(
        content.toString("utf8"),
      )
    )
      throw new DriveError(
        "CREDENTIAL_CONTENT",
        "Artifact appears to contain OAuth credentials; remove credentials before uploading.",
      );
  }
  private multipart(
    metadata: Record<string, unknown>,
    content: Buffer,
    mimeType: string,
  ) {
    const boundary = `wood-${randomUUID()}`;
    return {
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
        ),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    };
  }
  async create(
    name: FolderName,
    filename: string,
    content: Buffer,
    mimeType: string,
    nativeDocument = false,
  ) {
    this.validateContent(content, mimeType);
    if (
      !filename.trim() ||
      filename.length > 240 ||
      /[\x00-\x1f/\\]/.test(filename)
    )
      throw new DriveError(
        "INVALID_FILENAME",
        "Use a non-empty filename without path separators or control characters.",
      );
    if (nativeDocument && !mimeType.startsWith("text/"))
      throw new DriveError(
        "INVALID_MIME_TYPE",
        "Native document creation accepts text content only.",
      );
    const folder = this.folder(name, true);
    const parent = await this.authorizeFile(name, folder.id);
    if (parent.file.capabilities?.canAddChildren !== true)
      throw new DriveError(
        "PERMISSION_DENIED",
        "The current account cannot add files to this folder.",
      );
    const duplicate = await this.json<{ files: DriveFile[] }>(
      `drive/v3/files?${new URLSearchParams({
        q: `'${quote(folder.id)}' in parents and name = '${quote(filename)}' and trashed = false`,
        fields: "files(id)",
        pageSize: "1",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      })}`,
    );
    if (duplicate.files.length)
      throw new DriveError(
        "NAME_EXISTS",
        "A file with that name already exists. Choose a new name or explicitly update a retrieved revision.",
      );
    return this.json<DriveFile>(
      `upload/drive/v3/files?${new URLSearchParams({ uploadType: "multipart", fields, supportsAllDrives: "true" })}`,
      "write",
      {
        method: "POST",
        ...this.multipart(
          {
            name: filename,
            parents: [folder.id],
            mimeType: nativeDocument ? DOC : mimeType,
          },
          content,
          mimeType,
        ),
      },
    );
  }
  async update(
    name: FolderName,
    id: string,
    expectedEtag: string,
    content: Buffer,
    mimeType: string,
  ) {
    this.validateContent(content, mimeType);
    if (!/^"[^"\r\n]+"$/.test(expectedEtag))
      throw new DriveError(
        "REVISION_REQUIRED",
        "Supply the exact strong ETag returned when retrieving this file; wildcard updates are forbidden.",
      );
    const current = await this.authorizeFile(name, id, true);
    if (current.file.mimeType.startsWith("application/vnd.google-apps."))
      throw new DriveError(
        "NATIVE_DOCUMENT_UPDATE_REQUIRED",
        "Use the structure-preserving document update tool for native Google Docs.",
      );
    if (!current.etag)
      throw new DriveError(
        "CONDITIONAL_UPDATE_UNAVAILABLE",
        "Drive did not supply a strong ETag. Refusing a blob update without server-side concurrency protection.",
      );
    if (current.etag !== expectedEtag)
      throw new DriveError(
        "REVISION_CONFLICT",
        "File changed since retrieval. Reconcile the current content before updating.",
      );
    return this.json<DriveFile>(
      `upload/drive/v3/files/${driveId(id)}?${new URLSearchParams({ uploadType: "media", fields, supportsAllDrives: "true" })}`,
      "write",
      {
        method: "PATCH",
        headers: { "Content-Type": mimeType, "If-Match": expectedEtag },
        body: new Uint8Array(content),
      },
    );
  }
  async updateDocument(
    name: FolderName,
    id: string,
    revision: string,
    find: string,
    replacement: string,
  ) {
    if (
      !revision ||
      revision.length > 512 ||
      !find ||
      find.length > 100_000 ||
      replacement.length > 100_000
    )
      throw new DriveError(
        "REVISION_REQUIRED",
        "Supply the retrieved revision ID, non-empty exact text to replace and bounded replacement text.",
      );
    this.validateContent(Buffer.from(replacement), "text/plain");
    const current = await this.authorizeFile(name, id, true);
    if (current.file.mimeType !== DOC)
      throw new DriveError(
        "INVALID_DOCUMENT_TYPE",
        "This operation supports native Google Docs only.",
      );
    return this.json(`docs/v1/documents/${driveId(id)}:batchUpdate`, "write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        writeControl: { requiredRevisionId: revision },
        requests: [
          {
            replaceAllText: {
              containsText: { text: find, matchCase: true },
              replaceText: replacement,
            },
          },
        ],
      }),
    });
  }
}
