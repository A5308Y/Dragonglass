import { Notice } from "obsidian";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGtdSnapshot } from "../ui/hooks";
import type { GtdServices } from "../ui/services";

const WORDS = [
  "alignment", "ambiguity", "attention", "boundary", "breakthrough", "calm", "challenge", "clarity", "coherence", "constraint",
  "contrast", "curiosity", "decision", "empathy", "friction", "generosity", "momentum", "possibility", "question", "simplicity",
  "absorb", "accelerate", "adapt", "align", "amplify", "anchor", "assemble", "balance", "blend", "branch",
  "bridge", "build", "calibrate", "capture", "carve", "cascade", "clarify", "combine", "compress", "connect",
  "algae", "aquifer", "archipelago", "aurora", "avalanche", "bark", "basalt", "blossom", "boulder", "canopy",
  "canyon", "cave", "cedar", "current", "delta", "forest", "glacier", "horizon", "island", "river",
  "anchor", "antenna", "anvil", "arcade", "arrow", "atrium", "axle", "balcony", "beacon", "bellows",
  "blade", "bridge", "compass", "hinge", "key", "lens", "mirror", "pulley", "sieve", "window",
  "airy", "amber", "aromatic", "azure", "bitter", "blurred", "bold", "braided", "brittle", "briny",
  "crisp", "dappled", "echoing", "glowing", "grainy", "luminous", "muted", "rough", "silken", "warm",
];

export function BrainstormView({ services }: { services: GtdServices }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const candidates = useMemo(
    () => snapshot.actions.filter((action) => action.status !== "done" && action.status !== "cancelled" && /brainstorm/i.test(action.title)),
    [snapshot],
  );
  const [selectedId, setSelectedId] = useState<string | null>(() => randomItem(candidates)?.id ?? null);
  const [standaloneTopic, setStandaloneTopic] = useState("");
  const [standalone, setStandalone] = useState(false);
  const action = standalone ? undefined : candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0];
  const project = action?.projectId ? snapshot.projectsById.get(action.projectId) : undefined;
  const sessionKey = standalone ? `standalone:${standaloneTopic}` : action?.id;
  const sessionActive = Boolean(action || standalone);
  const [desiredOutcome, setDesiredOutcome] = useState("");
  const [ideas, setIdeas] = useState("");
  const [words, setWords] = useState(() => pickRandom(WORDS, 10));
  const [seconds, setSeconds] = useState(300);
  const [saving, setSaving] = useState(false);
  const ideasRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (standalone) return;
    if (!action) setSelectedId(null);
    else if (action.id !== selectedId) setSelectedId(action.id);
  }, [standalone, action?.id, selectedId]);

  useEffect(() => {
    let cancelled = false;
    setDesiredOutcome("");
    setIdeas("");
    setWords(pickRandom(WORDS, 10));
    setSeconds(300);
    if (project) void services.repository.readDesiredOutcome(project).then((value) => { if (!cancelled) setDesiredOutcome(value); });
    return () => { cancelled = true; };
  }, [sessionKey]);

  useEffect(() => {
    if (!sessionActive) return;
    const timer = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [sessionKey, sessionActive]);

  const shuffleTask = () => {
    if (!candidates.length) return;
    const alternatives = candidates.filter((candidate) => candidate.id !== action?.id);
    setSelectedId((randomItem(alternatives.length ? alternatives : candidates) ?? candidates[0])!.id);
  };

  const save = async () => {
    if (!ideas.trim() || (!action && !standalone)) return;
    setSaving(true);
    try {
      if (action) {
        await services.repository.saveBrainstorm(action.id, ideas, project ? desiredOutcome : undefined);
        new Notice(project ? "Brainstorm saved to Project support material; Action completed." : "Brainstorm captured to Inbox; Action completed.");
      } else {
        await services.repository.saveStandaloneBrainstorm(standaloneTopic, ideas);
        new Notice("Standalone brainstorm captured to Inbox.");
        setStandalone(false);
        setStandaloneTopic("");
      }
      setIdeas("");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not save the brainstorm.");
    } finally {
      setSaving(false);
    }
  };

  const insertWord = (word: string) => {
    const textarea = ideasRef.current;
    const start = textarea?.selectionStart ?? ideas.length;
    const end = textarea?.selectionEnd ?? start;
    const before = ideas.slice(0, start);
    const after = ideas.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const insertion = `${prefix}${word}${suffix}`;
    setIdeas(`${before}${insertion}${after}`);
    window.requestAnimationFrame(() => {
      const cursor = start + insertion.length;
      ideasRef.current?.focus();
      ideasRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div class="dg-view dg-brainstorm-view">
      <header class="dg-view-header">
        <div><h2>Brainstorm</h2><span class="dg-count">{candidates.length}</span></div>
        {sessionActive && <span class={seconds === 0 ? "dg-brainstorm-timer is-done" : "dg-brainstorm-timer"}>{seconds === 0 ? "✓ five minutes reached" : formatTimer(seconds)}</span>}
      </header>

      {!sessionActive ? (
        <div class="dg-workflow-complete dg-brainstorm-empty">
          <span>💡</span>
          <h3>Start a standalone brainstorm</h3>
          <p>No “brainstorm” Action is required. The result will be captured as an Inbox Item.</p>
          <section class="dg-brainstorm-field dg-brainstorm-start-field">
            <label>Brainstorming topic</label>
            <div class="dg-brainstorm-start">
              <input
                autofocus
                value={standaloneTopic}
                placeholder="What do you want to brainstorm?"
                onInput={(event: Event) => setStandaloneTopic((event.currentTarget as HTMLInputElement).value)}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key === "Enter" && standaloneTopic.trim()) setStandalone(true);
                }}
              />
              <button class="mod-cta" disabled={!standaloneTopic.trim()} onClick={() => setStandalone(true)}>Start brainstorming</button>
            </div>
          </section>
        </div>
      ) : (
        <div class="dg-brainstorm-content">
          <section class="dg-brainstorm-task">
            <div>
              <span>{standalone ? "Standalone topic" : "Brainstorm this"}</span>
              <h3>{standalone ? standaloneTopic : action?.title}</h3>
              {project
                ? <button onClick={() => services.showProjectDetail(project.id)}>{project.title}</button>
                : <small>{standalone ? "No source Action — output will return to Inbox" : "No Project — output will return to Inbox"}</small>}
            </div>
            {standalone
              ? <button onClick={() => setStandalone(false)}>Change topic</button>
              : <button onClick={shuffleTask}>Shuffle</button>}
          </section>

          <section class="dg-word-bank">
            <div class="dg-section-heading"><h3>Random prompts</h3><button onClick={() => setWords(pickRandom(WORDS, 10))}>Shuffle words</button></div>
            <div>{words.map((word) => <button key={word} onClick={() => insertWord(word)}>{word}</button>)}</div>
          </section>

          {project && (
            <section class="dg-brainstorm-field">
              <label>Desired outcome</label>
              <textarea value={desiredOutcome} placeholder="What future state are you working toward?" onInput={(event: Event) => setDesiredOutcome((event.currentTarget as HTMLTextAreaElement).value)} />
            </section>
          )}

          <section class="dg-brainstorm-field dg-ideas-field">
            <label>Your ideas</label>
            <textarea ref={ideasRef} autofocus value={ideas} placeholder={"Let it flow—there are no wrong answers.\n\nTry another angle. Reverse it. Find the simplest version. Imagine unlimited resources."} onInput={(event: Event) => setIdeas((event.currentTarget as HTMLTextAreaElement).value)} />
          </section>

          <div class="dg-workflow-footer">
            <span>{project ? `Saves into ${project.title}'s support folder` : "Creates a new Inbox Item"}</span>
            <button class="mod-cta" disabled={!ideas.trim() || saving} onClick={() => void save()}>{saving ? "Saving…" : standalone ? "Save ideas to Inbox" : "Save ideas and complete Action"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function pickRandom<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const result: T[] = [];
  while (pool.length && result.length < count) result.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  return result;
}

function randomItem<T>(items: readonly T[]): T | undefined {
  return items.length ? items[Math.floor(Math.random() * items.length)] : undefined;
}

function formatTimer(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
