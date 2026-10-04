import { Modal, Setting, type App } from "obsidian";
import {
  delegationBody, delegationKey, delegationSubject, isEmailAddress, mailtoUrl, recentRecipients,
} from "../domain/email-delegation";
import type { Action } from "../domain/types";
import { addLocalDays, localDate } from "../utils/date";
import type { GtdServices } from "./services";
import { showUndoNotice } from "./undo";

/** How long a delegated Action waits before its follow-up, unless changed in the dialog. */
const FOLLOW_UP_DAYS = 7;

/**
 * Delegates an Action by email: asks who to, makes the Action Waiting with that address and a
 * follow-up date, and opens the message in the mail app. Offers Undo for the Action's change;
 * the message itself is the mail app's to send or discard.
 */
export async function delegateActionByEmail(services: GtdServices, actionId: string): Promise<void> {
  const { repository } = services;
  const snapshot = repository.index.getSnapshot();
  const action = snapshot.actionsById.get(actionId);
  if (!action) throw new Error("This Action no longer exists.");
  const project = action.projectId ? snapshot.projectsById.get(action.projectId) : undefined;
  const desiredOutcome = project ? await repository.readDesiredOutcome(project) : "";
  const key = delegationKey(action.id);
  new DelegateActionModal(services.app, {
    to: action.delegatedTo ?? "",
    recipients: recentRecipients(snapshot.actions),
    subject: delegationSubject(action.title, key),
    body: delegationBody({ title: action.title, ...(project ? { projectTitle: project.title, desiredOutcome } : {}) }),
    followUp: action.followUp ?? addLocalDays(localDate(), FOLLOW_UP_DAYS),
  }, async (form) => {
    await repository.updateAction(action.id, { status: "waiting", followUp: form.followUp, delegatedTo: form.to });
    openMailto(mailtoUrl(form.to, delegationSubject(form.subject, key), form.body));
    showUndoNotice(`Waiting for ${form.to}: “${action.title}”.`, () => restore(services, action));
  }).open();
}

/** Puts the Action back as it was before it was delegated. */
async function restore(services: GtdServices, before: Action): Promise<void> {
  await services.repository.updateAction(before.id, {
    status: before.status,
    followUp: before.followUp ?? "",
    delegatedTo: before.delegatedTo ?? "",
    ...(before.waitingSince ? { waitingSince: before.waitingSince } : {}),
    ...(before.context ? { context: before.context } : {}),
    ...(before.energy ? { energy: before.energy } : {}),
  });
}

/** Opens the link the way a `mailto:` link in a note opens: in the mail app. */
function openMailto(url: string): void {
  const link = document.body.createEl("a", { href: url, attr: { target: "_blank", rel: "noopener" } });
  link.click();
  link.remove();
}

interface DelegationForm {
  to: string;
  subject: string;
  body: string;
  followUp: string;
}

class DelegateActionModal extends Modal {
  private sending = false;

  constructor(
    app: App,
    private readonly initial: DelegationForm & { recipients: string[] },
    private readonly submit: (form: DelegationForm) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, initial } = this;
    contentEl.addClass("dg-button-scope", "dg-delegate", "dg-delegate-email");
    this.titleEl.setText("Delegate by email");
    contentEl.createEl("p", {
      cls: "dg-delegate-note",
      text: "Your mail app opens with this message. The Action waits for the answer; a reply that keeps "
        + "the marker in the subject is linked to it when mail is imported.",
    });

    const field = (id: string, label: string) => {
      contentEl.createEl("label", { text: label, attr: { for: id }, cls: "dg-delegate-label" });
    };
    field("dg-delegate-to", "To");
    const to = contentEl.createEl("input", {
      attr: { id: "dg-delegate-to", type: "email", list: "dg-delegate-recipients", placeholder: "name@example.com" },
    });
    to.value = initial.to;
    const recipients = contentEl.createEl("datalist", { attr: { id: "dg-delegate-recipients" } });
    for (const recipient of initial.recipients) recipients.createEl("option", { attr: { value: recipient } });

    field("dg-delegate-subject", "Subject");
    const subject = contentEl.createEl("input", { attr: { id: "dg-delegate-subject", type: "text" } });
    subject.value = initial.subject;

    field("dg-delegate-body", "Message");
    const body = contentEl.createEl("textarea", { cls: "dg-delegate-instructions", attr: { id: "dg-delegate-body", rows: "10" } });
    body.value = initial.body;

    field("dg-delegate-follow-up", "Follow up on");
    const followUp = contentEl.createEl("input", { attr: { id: "dg-delegate-follow-up", type: "date" } });
    followUp.value = initial.followUp;

    const error = contentEl.createEl("p", { cls: "dg-delegate-error" });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Write email").setCta().onClick(() => {
        if (this.sending) return;
        if (!isEmailAddress(to.value)) {
          error.setText("Enter one email address, like name@example.com.");
          to.focus();
          return;
        }
        this.sending = true;
        void this.submit({ to: to.value.trim(), subject: subject.value, body: body.value, followUp: followUp.value })
          .then(() => this.close())
          .catch((failure: unknown) => {
            this.sending = false;
            error.setText(failure instanceof Error ? failure.message : "Could not delegate the Action.");
          });
      }));
    window.setTimeout(() => (initial.to ? body : to).focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
