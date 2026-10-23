import { clip, jsonObject, normalise, tidy, withoutThinking, type ChatMessage } from "./brainstorm-partner";

/**
 * A partner for processing the Inbox: asked about one Item, it suggests what the Item
 * could become (an Action, with a Project, context and mode) and judges the Action written so
 * far: small enough to do in one sitting, and real progress, not just "open the file".
 *
 * It sees only what the processing page shows: the Item, the form, and the Projects,
 * contexts and modes the pickers search. It only suggests; the person applies a suggestion or not.
 * The view switches it on per Item and drops it once the Item is processed.
 */

export const ITEM_KINDS = ["note", "mail", "audio"] as const;
export type ProcessingItemKind = (typeof ITEM_KINDS)[number];

export interface ProcessingRequest {
  item: { title: string; body: string; kind: ProcessingItemKind };
  form: {
    /** What the Project field says: an existing Project's breadcrumb or a new name. */
    project: string;
    projectIsNew: boolean;
    vision: string;
    action: string;
    /** `next`, `waiting` or `scheduled`. */
    status: string;
    context: string;
    /** The inner state the Action suits; optional, like the field. */
    mode?: string;
  };
  /** The Projects the picker offers, as breadcrumbs with their status. */
  projects: Array<{ name: string; status: string }>;
  contexts: string[];
  modes?: string[];
}

export const VERDICTS = ["good", "too-big", "no-progress", "vague"] as const;
export type ActionVerdict = (typeof VERDICTS)[number];

export interface ProcessingSuggestion {
  action: string;
  /** An existing Project's breadcrumb, or a new Project's name; absent for a single Action. */
  project?: string;
  newProject: boolean;
  /** For a new Project: what will be true when it is done. */
  desiredOutcome?: string;
  context?: string;
  mode?: string;
  why: string;
}

export interface ProcessingAdvice {
  actionable: "yes" | "no" | "unclear";
  /** Where a non-actionable Item belongs. */
  nonActionable?: "trash" | "reference" | "someday";
  summary: string;
  suggestions: ProcessingSuggestion[];
  /** The judgement of the Action in the form; only when it has one. */
  check?: { verdict: ActionVerdict; note: string; better?: string };
}

const SYSTEM = [
  "You help a person process one item from their GTD inbox. You see the item and the processing form.",
  "First decide whether the item is actionable. If it isn't, say whether it is trash, reference or someday.",
  "If it is, suggest up to 3 next actions. A good next action starts with a verb, is one physical, visible step",
  "that can be done in one sitting (5 to 60 minutes), and leaves a result that moves toward the goal:",
  "a decision made, a draft written, a message sent, a thing bought, a call held.",
  "Opening, looking at, checking, reviewing or thinking about something without producing anything is not progress:",
  "the person just has to open it again next time. Name the step that produces the result instead",
  "(not \"Open the contract\" but \"Mark the three clauses to renegotiate in the contract\").",
  "An outcome that needs more than one action is a project: suggest an existing project from the list by its exact name,",
  "or a new project name with a desired outcome, and give its first action. A single action needs no project.",
  "Use a context from the list when one fits. A mode is the inner state the action suits (focused, creative, restless…):",
  "give one from the list only when one clearly fits, and otherwise null.",
  "If the form has an action, judge it: good, too-big (several steps or more than an hour), no-progress",
  "(nothing changes when it's done) or vague (unclear what to do), with a short note and, unless it's good, a better wording.",
  "Write in the language of the item.",
  "Answer with JSON only:",
  '{"actionable": "yes|no|unclear", "nonActionable": "trash|reference|someday|null", "summary": "one line",',
  '"suggestions": [{"action": "…", "project": "existing or new name, or null", "newProject": false, "desiredOutcome": "… or null", "context": "… or null", "mode": "… or null", "why": "one line"}],',
  '"check": {"verdict": "good|too-big|no-progress|vague", "note": "…", "better": "… or null"} or null}',
].join(" ");

/** The most Projects listed, so a large vault still fits a small context. */
const PROJECT_LIMIT = 400;

export function processingMessages(request: ProcessingRequest): ChatMessage[] {
  const { item, form } = request;
  const field = (name: string, value: string) => `${name}: ${value.trim() ? clip(value, 1_000) : "(empty)"}`;
  const lines = [
    `Inbox item${itemKindNote(item)}: ${clip(item.title, 500)}`,
    "",
    item.body.trim() ? clip(item.body) : "(no text)",
    "",
    "The form so far:",
    field(form.projectIsNew ? "Project (new)" : "Project", form.project),
    field("Project vision", form.vision),
    field("Action", form.action),
    `Action status: ${form.status}`,
    field("Context", form.context),
    field("Mode", form.mode ?? ""),
    "",
    "Projects:",
    ...(request.projects.length
      ? request.projects.slice(0, PROJECT_LIMIT).map((project) => `- ${project.name}${project.status === "active" ? "" : ` (${project.status})`}`)
      : ["(none)"]),
    "",
    `Contexts: ${request.contexts.length ? request.contexts.join(", ") : "(none)"}`,
    `Modes: ${request.modes?.length ? request.modes.join(", ") : "(none)"}`,
  ];
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

/** What kind of Item it is, when not a note; a voice memo's text is its transcript, if it has one. */
function itemKindNote(item: ProcessingRequest["item"]): string {
  if (item.kind === "mail") return " (an email)";
  if (item.kind === "audio") return item.body.trim() ? " (a voice memo; its transcript follows)" : " (a voice memo, not transcribed)";
  return "";
}

/**
 * The question as one text, for Codex, which takes a prompt rather than chat messages.
 * It is told to answer from the text alone: it starts in an empty folder anyway.
 */
export function processingPrompt(request: ProcessingRequest): string {
  const [system, user] = processingMessages(request);
  return `${system!.content}\nAnswer from this message alone: don't run commands or look for files.\n\n${user!.content}\n`;
}

const nullableString = { type: ["string", "null"] };

/** The answer's shape, as a strict JSON schema: Codex keeps its final message to it. */
export const PROCESSING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actionable", "nonActionable", "summary", "suggestions", "check"],
  properties: {
    actionable: { type: "string", enum: ["yes", "no", "unclear"] },
    nonActionable: { type: ["string", "null"], enum: ["trash", "reference", "someday", null] },
    summary: { type: "string" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "project", "newProject", "desiredOutcome", "context", "mode", "why"],
        properties: {
          action: { type: "string" },
          project: nullableString,
          newProject: { type: "boolean" },
          desiredOutcome: nullableString,
          context: nullableString,
          mode: nullableString,
          why: { type: "string" },
        },
      },
    },
    check: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "note", "better"],
          properties: {
            verdict: { type: "string", enum: [...VERDICTS] },
            note: { type: "string" },
            better: nullableString,
          },
        },
      ],
    },
  },
} as const;

/**
 * Reads the model's answer, found even after thinking or inside a code fence. Project
 * names are matched to the list (a name not on it is a new Project), contexts to their
 * existing spelling, and a mode is kept only when it is one already in use; a judgement is kept only when the form had an Action to judge.
 */
export function parseProcessingReply(text: string, request: ProcessingRequest): ProcessingAdvice {
  const parsed = jsonObject(withoutThinking(text));
  if (!parsed) throw new Error("The partner's answer couldn't be read; Check again asks once more.");
  const actionable = oneOf(parsed.actionable, ["yes", "no", "unclear"] as const) ?? "unclear";
  const nonActionable = actionable === "yes" ? undefined : oneOf(parsed.nonActionable, ["trash", "reference", "someday"] as const);
  const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
    .map((value) => suggestion(value, request))
    .filter((value): value is ProcessingSuggestion => value !== null)
    .slice(0, 3);
  const advice: ProcessingAdvice = { actionable, summary: line(parsed.summary), suggestions };
  if (nonActionable) advice.nonActionable = nonActionable;
  const check = judgement(parsed.check, request);
  if (check) advice.check = check;
  return advice;
}

function suggestion(value: unknown, request: ProcessingRequest): ProcessingSuggestion | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const action = line(record.action);
  if (!action) return null;
  const result: ProcessingSuggestion = { action, newProject: false, why: line(record.why) };
  const named = line(record.project);
  if (named) {
    const known = matchProject(named, request.projects);
    result.project = known ?? named;
    result.newProject = !known;
    const outcome = line(record.desiredOutcome);
    if (!known && outcome) result.desiredOutcome = outcome;
  }
  const context = line(record.context);
  if (context) {
    const key = normalise(context.replace(/^@/, ""));
    result.context = request.contexts.find((known) => normalise(known.replace(/^@/, "")) === key) ?? context;
  }
  // Modes are the person's own words for an inner state, so the partner only picks from them.
  const mode = line(record.mode);
  const knownMode = mode ? request.modes?.find((known) => normalise(known) === normalise(mode)) : undefined;
  if (knownMode) result.mode = knownMode;
  return result;
}

function judgement(value: unknown, request: ProcessingRequest): ProcessingAdvice["check"] {
  if (!request.form.action.trim() || !value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const verdict = oneOf(record.verdict, VERDICTS);
  if (!verdict) return undefined;
  const better = line(record.better);
  return {
    verdict,
    note: line(record.note),
    ...(verdict !== "good" && better && normalise(better) !== normalise(request.form.action) ? { better } : {}),
  };
}

/** A Project on the list by its breadcrumb or its own title, written as the list writes it. */
function matchProject(name: string, projects: ProcessingRequest["projects"]): string | undefined {
  const key = normalise(name);
  const byName = projects.find((project) => normalise(project.name) === key);
  if (byName) return byName.name;
  const byTitle = projects.filter((project) => normalise(project.name.split(" > ").pop() ?? "") === key);
  return byTitle.length === 1 ? byTitle[0]!.name : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.find((option) => option === text);
}

/** A string field as one tidy line; models write "null" for nothing, too. */
function line(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = tidy(value);
  return text.toLowerCase() === "null" ? "" : text;
}
