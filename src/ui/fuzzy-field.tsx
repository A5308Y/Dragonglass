import { prepareFuzzySearch, sortSearchResults, type SearchResult } from "obsidian";
import { useMemo, useState } from "preact/hooks";

export interface FuzzyOption {
  id: string;
  label: string;
  meta?: string;
  aliases?: readonly string[];
}

export function FuzzyField({
  value,
  placeholder,
  options,
  onChange,
  onChoose,
}: {
  value: string;
  placeholder: string;
  options: readonly FuzzyOption[];
  onChange: (value: string) => void;
  onChoose: (option: FuzzyOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const suggestions = useMemo(() => {
    const query = value.trim();
    if (!query) return options.slice(0, 8);
    const fuzzy = prepareFuzzySearch(query);
    const matches: Array<{ option: FuzzyOption; match: SearchResult; tier: number; shortestMatch: number }> = [];
    for (const option of options) {
      const labels = [option.label, ...(option.aliases ?? [])];
      const match = fuzzy(`${labels.join(" ")} ${option.meta ?? ""}`);
      if (!match) continue;
      const tiers = labels.map((label) => matchTier(label, query));
      const tier = Math.min(...tiers);
      matches.push({
        option,
        match,
        tier,
        shortestMatch: Math.min(...labels.filter((_, index) => tiers[index] === tier).map((label) => label.length)),
      });
    }
    sortSearchResults(matches);
    matches.sort((left, right) => left.tier - right.tier || left.shortestMatch - right.shortestMatch);
    return matches.slice(0, 8).map(({ option }) => option);
  }, [value, options]);

  return (
    <div class="dg-fuzzy-field">
      <input
        value={value}
        placeholder={placeholder}
        autocomplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 100)}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Escape") return setOpen(false);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((current) => suggestions.length ? (current + direction + suggestions.length) % suggestions.length : 0);
          }
          if (event.key === "Enter" && open && suggestions[activeIndex]) {
            event.preventDefault();
            onChoose(suggestions[activeIndex]);
            setOpen(false);
          }
        }}
        onInput={(event: Event) => {
          onChange((event.currentTarget as HTMLInputElement).value);
          setActiveIndex(0);
          setOpen(true);
        }}
      />
      {open && suggestions.length > 0 && (
        <div class="dg-fuzzy-results" role="listbox">
          {suggestions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              class={activeIndex === index ? "is-active" : ""}
              onMouseDown={(event: MouseEvent) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => { onChoose(option); setOpen(false); }}
            >
              <span>{option.label}</span>{option.meta && <small>{option.meta}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function matchTier(label: string, query: string): number {
  const normalizedLabel = label.trim().toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedLabel === normalizedQuery) return 0;
  if (normalizedLabel.startsWith(normalizedQuery)) return 1;
  return 2;
}
