import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Filter dropdown for the ops console (same pattern as apps/web's
 * FilterDropdown, which has the date/select variants; the two apps share no
 * UI package): a trigger that names the filter and its value, and a panel of
 * checkboxes. UI state only — the values sent to the server are unchanged.
 */

/** "partially_captured" → "Partially captured" (display only; values stay raw). */
export function humanize(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface DropdownProps {
  label: string;
  summary: string;
  active: boolean;
  onClear?: () => void;
  children: ReactNode;
}

function Dropdown({ label, summary, active, onClear, children }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Close on a click outside or Escape (focus goes back to the trigger).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="admin-dd" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`admin-dd-trigger${active ? " admin-dd-trigger-active" : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="admin-dd-label">{label}</span>
        <span className="admin-dd-summary">{summary}</span>
        <svg className="admin-dd-chevron" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="admin-dd-panel" id={panelId} role="dialog" aria-label={`${label} filter`}>
          {children}
          <div className="admin-dd-footer">
            {onClear ? (
              <button type="button" className="admin-dd-clear" disabled={!active} onClick={onClear}>
                Clear
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="admin-dd-done" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface MultiSelectFilterProps<T extends string> {
  label: string;
  options: readonly T[];
  selected: T[];
  onChange: (next: T[]) => void;
  /** Trigger text when nothing is picked; defaults to "All" (no filter). */
  emptyLabel?: string;
}

/** Pick any number of values; none picked means no filter ("All"). */
export function MultiSelectFilter<T extends string>({ label, options, selected, onChange, emptyLabel = "All" }: MultiSelectFilterProps<T>) {
  const summary =
    selected.length === 0 ? emptyLabel : selected.length === 1 ? humanize(selected[0] as string) : `${selected.length} selected`;

  function toggle(value: T): void {
    const next = selected.includes(value) ? selected.filter((s) => s !== value) : [...selected, value];
    onChange(options.filter((option) => next.includes(option))); // keep option order, so the query is stable
  }

  return (
    <Dropdown label={label} summary={summary} active={selected.length > 0} onClear={() => onChange([])}>
      <fieldset className="admin-dd-options">
        <legend className="admin-sr-only">{label}</legend>
        {options.map((option) => (
          <label key={option} className="admin-dd-option">
            <input type="checkbox" checked={selected.includes(option)} onChange={() => toggle(option)} />
            {humanize(option)}
          </label>
        ))}
      </fieldset>
    </Dropdown>
  );
}
