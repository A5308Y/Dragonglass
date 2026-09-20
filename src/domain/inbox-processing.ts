/** Default title used when clarifying an Inbox Item into a Project or Action. */
export function inboxProcessingPrefill(title: string): string {
  return Array.from(title).slice(0, 50).join("");
}

export interface InboxPrimaryDisposition {
  /** The repository operation the primary processing button runs. */
  operation: "next-action" | "file";
  label: string;
  ready: boolean;
}

/**
 * Resolves what the primary processing button does.
 *
 * Filing the original is a choice, not a separate disposition: with it off the capture is
 * consumed by the Action it produces, and with it on the capture survives as reference and
 * the Next Action becomes optional.
 */
export function inboxPrimaryDisposition(input: {
  fileOriginal: boolean;
  projectName: string;
  projectExists: boolean;
  nextAction: string;
  context: string;
}): InboxPrimaryDisposition {
  const nextAction = input.nextAction.trim();
  const context = input.context.trim();
  const projectName = input.projectName.trim();
  if (input.fileOriginal) {
    const target = projectName ? `File with ${projectName}` : "File as General Reference";
    return {
      operation: "file",
      label: `${target}${nextAction ? " + Next Action" : ""}`,
      // A Next Action is optional when filing, but once typed it still needs a context.
      ready: !nextAction || Boolean(context),
    };
  }
  return {
    operation: "next-action",
    label: projectName
      ? input.projectExists ? `Create Next Action in ${projectName}` : "Create Project + Next Action"
      : "Create Next Action",
    ready: Boolean(nextAction && context),
  };
}
