/** Default title used when clarifying an Inbox Item into a Project or Action. */
export function inboxProcessingPrefill(title: string): string {
  return Array.from(title).slice(0, 50).join("");
}

export interface InboxPrimaryDisposition {
  /** The repository operation the primary processing button runs. */
  operation: "next-action" | "file" | "someday";
  label: string;
  ready: boolean;
}

/**
 * Resolves what the primary processing button does.
 *
 * Two choices shape it rather than two more buttons. Someday/Maybe decides whether the Project
 * this touches is parked or active; filing decides whether the capture survives as reference.
 * With filing off the capture is consumed by what it produces, and with it on the Next Action
 * becomes optional, which is how a capture is filed as pure reference.
 */
export function inboxPrimaryDisposition(input: {
  someday: boolean;
  fileOriginal: boolean;
  projectName: string;
  projectExists: boolean;
  nextAction: string;
  context: string;
}): InboxPrimaryDisposition {
  const nextAction = input.nextAction.trim();
  const context = input.context.trim();
  const projectName = input.projectName.trim();
  const withAction = nextAction ? " + Next Action" : "";
  // These dispositions need no Next Action, but once one is typed it still needs a context.
  const optionalActionReady = !nextAction || Boolean(context);

  if (input.someday) {
    const target = input.projectExists && projectName
      ? `Move ${projectName} to Someday/Maybe`
      : "Create Someday/Maybe Project";
    return { operation: "someday", label: `${target}${withAction}`, ready: optionalActionReady };
  }
  if (input.fileOriginal) {
    const target = projectName ? `File with ${projectName}` : "File as General Reference";
    return { operation: "file", label: `${target}${withAction}`, ready: optionalActionReady };
  }
  return {
    operation: "next-action",
    label: projectName
      ? input.projectExists ? `Create Next Action in ${projectName}` : "Create Project + Next Action"
      : "Create Next Action",
    ready: Boolean(nextAction && context),
  };
}
