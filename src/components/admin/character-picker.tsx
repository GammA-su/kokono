"use client";

import { useId, useMemo, useRef, useState } from "react";

export type CharacterOption = {
  id: string;
  name: string;
  japaneseName?: string | null;
  aliases?: string[];
};

function haystack(option: CharacterOption) {
  return [option.name, option.japaneseName ?? "", ...(option.aliases ?? [])]
    .join(" ")
    .toLowerCase();
}

/**
 * Keyboard-first multi-select over the franchise's existing Character records.
 * Typing filters, Enter selects the highlighted entry, and an unmatched name can be
 * created in place; Backspace on an empty query removes the last selection.
 */
export function CharacterPicker({
  label,
  options,
  selected,
  onChange,
  onCreate,
  creating = false,
}: {
  label: string;
  options: CharacterOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onCreate?: (name: string) => void;
  creating?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const byId = useMemo(
    () => new Map(options.map((option) => [option.id, option])),
    [options],
  );
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options
      .filter((option) => !selected.includes(option.id))
      .filter((option) => !needle || haystack(option).includes(needle))
      .slice(0, 8);
  }, [options, query, selected]);
  const exact = options.some(
    (option) => option.name.toLowerCase() === query.trim().toLowerCase(),
  );
  const canCreate = Boolean(onCreate) && query.trim().length > 0 && !exact;
  const entries = canCreate ? matches.length + 1 : matches.length;

  function choose(index: number) {
    if (canCreate && index === matches.length) {
      onCreate?.(query.trim());
      setQuery("");
      return;
    }
    const option = matches[index];
    if (!option) return;
    onChange([...selected, option.id]);
    setQuery("");
    setActive(0);
  }
  return (
    <div className="character-picker">
      <div className="character-chips">
        {selected.map((id) => (
          <span className="chip" key={id}>
            {byId.get(id)?.name ?? "Unknown character"}
            <button
              type="button"
              aria-label={`Remove ${byId.get(id)?.name ?? "character"}`}
              onClick={() => onChange(selected.filter((value) => value !== id))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded={open && entries > 0}
        aria-controls={listId}
        aria-label={label}
        autoComplete="off"
        className="character-input"
        placeholder={selected.length ? "Add another…" : "Search characters…"}
        value={query}
        disabled={creating}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => (entries ? (index + 1) % entries : 0));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) =>
              entries ? (index - 1 + entries) % entries : 0,
            );
          } else if (event.key === "Enter" && open && entries) {
            // Enter completes the selection here instead of moving to the next row.
            event.preventDefault();
            event.stopPropagation();
            choose(active);
          } else if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Backspace" && !query && selected.length) {
            onChange(selected.slice(0, -1));
          }
        }}
      />
      {open && entries > 0 && (
        <ul className="character-options" id={listId} role="listbox">
          {matches.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                className={index === active ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                {option.name}
                {option.japaneseName && (
                  <span className="japanese" lang="ja">
                    {option.japaneseName}
                  </span>
                )}
              </button>
            </li>
          ))}
          {canCreate && (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={active === matches.length}
                className={
                  active === matches.length ? "active create" : "create"
                }
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(matches.length)}
                onClick={() => choose(matches.length)}
              >
                Create “{query.trim()}” in this franchise
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
