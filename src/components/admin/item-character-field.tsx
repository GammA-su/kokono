"use client";

import { useState, useTransition } from "react";
import { createCharacterForItem } from "@/modules/catalog/actions";
import { CharacterPicker, type CharacterOption } from "./character-picker";

/**
 * Character selection for the item form.
 *
 * A checkbox list can only ever offer characters that already exist, which made a new character
 * impossible to add while editing an item. This uses the same searchable picker as the bulk
 * editor, so an unmatched name can be created in the item's franchise without leaving the form.
 *
 * The selection is mirrored into hidden inputs because the surrounding form posts to a server
 * action; the picker's own state is not submitted.
 */
export function ItemCharacterField({
  lineupId,
  options,
  initialSelected,
}: {
  lineupId: string;
  options: CharacterOption[];
  initialSelected: string[];
}) {
  const [available, setAvailable] = useState(options);
  const [selected, setSelected] = useState(initialSelected);
  const [error, setError] = useState<string | null>(null);
  const [creating, startCreate] = useTransition();

  return (
    <>
      {selected.map((id) => (
        <input key={id} type="hidden" name="characterIds" value={id} />
      ))}
      <CharacterPicker
        label="Characters"
        options={available}
        selected={selected}
        creating={creating}
        onChange={(ids) => {
          setError(null);
          setSelected(ids);
        }}
        onCreate={(name) =>
          startCreate(async () => {
            setError(null);
            const result = await createCharacterForItem({ lineupId, name });
            if ("error" in result) {
              setError(result.error ?? "Could not create the character.");
              return;
            }
            // Add to the options and select it, so the operator sees the result immediately
            // without losing anything else they have typed into the form.
            setAvailable((current) => [...current, result.character]);
            setSelected((current) => [...current, result.character.id]);
          })
        }
      />
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!available.length && (
        <p className="muted small-copy">
          No characters catalogued for this franchise yet. Type a name to create
          the first one.
        </p>
      )}
    </>
  );
}
