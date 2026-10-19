import { isAbsolute } from "node:path";
import { runWood, type WoodRunner } from "./story.ts";

export type ReportingSelection = {
  story: string;
  owner: string;
  validation?: string;
  readiness?: string;
  reviewReference?: string;
  reviewedRevision?: string;
  pr?: number;
  retry?: boolean;
};

export function reportMilestones(
  selection: ReportingSelection,
  cwd: string,
  run: WoodRunner = runWood,
) {
  if (
    !/^[1-9][0-9]*$/.test(selection.story) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(selection.owner) ||
    (selection.validation !== undefined && !isAbsolute(selection.validation)) ||
    (selection.readiness !== undefined && !isAbsolute(selection.readiness)) ||
    ((selection.reviewReference !== undefined ||
      selection.reviewedRevision !== undefined) &&
      (typeof selection.reviewReference !== "string" ||
        !selection.reviewReference.trim() ||
        selection.reviewReference.length > 500 ||
        /[\r\n]/.test(selection.reviewReference) ||
        !/^[0-9a-f]{40,64}$/.test(selection.reviewedRevision ?? "") ||
        !selection.pr)) ||
    (selection.pr !== undefined &&
      (!Number.isSafeInteger(selection.pr) || selection.pr < 1)) ||
    (selection.retry &&
      (selection.pr !== undefined ||
        selection.validation !== undefined ||
        selection.readiness !== undefined ||
        selection.reviewReference !== undefined ||
        selection.reviewedRevision !== undefined))
  )
    throw new Error("Invalid milestone selectors");
  const args = [
    "story",
    "milestones",
    selection.story,
    "--owner",
    selection.owner,
    ...(selection.validation ? ["--validation", selection.validation] : []),
    ...(selection.readiness ? ["--readiness", selection.readiness] : []),
    ...(selection.reviewReference
      ? [
          "--review-reference",
          selection.reviewReference,
          "--reviewed-revision",
          selection.reviewedRevision!,
        ]
      : []),
    ...(selection.pr ? ["--pr", String(selection.pr)] : []),
    ...(selection.retry ? ["--retry"] : []),
  ];
  run(args, cwd);
  return run([...args, "--apply"], cwd).data;
}

// These are triggers for fresh Wood verification, never evidence of success.
export function milestoneTrigger(command: unknown, texts: string[]) {
  if (typeof command !== "string" || command.length > 8192) return;
  if (
    /^(?:uv run --active --frozen )?wood repo validate(?:\s|$)/.test(command)
  ) {
    for (const text of texts) {
      try {
        const value = JSON.parse(text);
        if (
          value?.schema_version === 2 &&
          value.command === "repo validate" &&
          value.status === "success" &&
          value.data?.passed === true &&
          typeof value.data.validation_file === "string" &&
          isAbsolute(value.data.validation_file)
        )
          return { validation: value.data.validation_file as string };
      } catch {
        /* Non-JSON tool output is not a validation record. */
      }
    }
  }
  const action = command.match(
    /^gh pr (?:create|merge|review|checks|view)(?:\s|$)([1-9][0-9]*)?/,
  );
  if (!action) return;
  const link = texts
    .join("\n")
    .match(
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/([1-9][0-9]*)\b/,
    );
  const pr = Number(action[1] ?? link?.[1]);
  return Number.isSafeInteger(pr) && pr > 0 ? { pr } : undefined;
}
