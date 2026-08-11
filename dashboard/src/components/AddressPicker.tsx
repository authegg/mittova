import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useDismiss } from "../hooks";

/**
 * A text field that offers the addresses you are allowed to use.
 *
 * A `datalist` would be a line of markup, but it cannot be styled, renders
 * differently in every browser, and on some of them shows nothing until a
 * character is typed — which is the moment this is most useful. So it is a
 * combobox: filtered as you type, keyboard driven, and closed when the value is
 * already an exact match, since there is nothing left to suggest.
 */
export default function AddressPicker({
  value,
  onChange,
  options,
  invalid,
  placeholder,
  ariaLabel,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  invalid?: boolean;
  placeholder?: string;
  ariaLabel: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const hits = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    // Nothing to offer when what is typed is already the whole answer.
    return hits.length === 1 && hits[0].toLowerCase() === q ? [] : hits;
  }, [value, options]);

  useDismiss(open, wrap, close);

  function choose(address: string) {
    onChange(address);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return setOpen(false);
    if (!matches.length) return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((n) => (n + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      return;
    }
    if (e.key === "Enter" && open) {
      e.preventDefault();
      choose(matches[active]);
    }
  }

  return (
    <div className="picker" ref={wrap}>
      <input
        className={`tpl-env-value mono${invalid ? " bad" : ""}`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        role="combobox"
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
      />

      {open && matches.length > 0 && (
        <ul className="picker-list" id={listId} role="listbox">
          <li className="picker-head">Mailboxes on this account</li>
          {matches.map((address, n) => (
            <li key={address}>
              <button
                type="button"
                role="option"
                aria-selected={n === active}
                className={`picker-item mono${n === active ? " on" : ""}`}
                onMouseEnter={() => setActive(n)}
                // mousedown, not click: the input's blur would close the list
                // out from under the pointer first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(address);
                }}
              >
                {address}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
