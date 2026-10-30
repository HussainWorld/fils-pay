import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { addDays, bahrainToday, dayRangeLabel } from "../format.js";

/**
 * Filter dropdowns for the dashboard toolbars: a trigger button that names
 * the filter and its current value, and a panel that opens under it. They
 * only hold UI state — every value still goes to the server as the same
 * query params the old checkbox/date controls sent.
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
    <div className="dash-dd" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`dash-dd-trigger${active ? " dash-dd-trigger-active" : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="dash-dd-label">{label}</span>
        <span className="dash-dd-summary">{summary}</span>
        <svg className="dash-dd-chevron" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="dash-dd-panel" id={panelId} role="dialog" aria-label={`${label} filter`}>
          {children}
          <div className="dash-dd-footer">
            {onClear ? (
              <button type="button" className="dash-dd-clear" disabled={!active} onClick={onClear}>
                Clear
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="dash-button dash-button-primary" onClick={() => setOpen(false)}>
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
  /** Render options as the table's status pills (`dash-status-<value>`). */
  pills?: boolean;
}

/** Pick any number of values; none picked means no filter ("All"). */
export function MultiSelectFilter<T extends string>({ label, options, selected, onChange, pills = true }: MultiSelectFilterProps<T>) {
  const summary =
    selected.length === 0 ? "All" : selected.length === 1 ? humanize(selected[0] as string) : `${selected.length} selected`;

  function toggle(value: T): void {
    const next = selected.includes(value) ? selected.filter((s) => s !== value) : [...selected, value];
    onChange(options.filter((option) => next.includes(option))); // keep option order, so the query is stable
  }

  return (
    <Dropdown label={label} summary={summary} active={selected.length > 0} onClear={() => onChange([])}>
      <fieldset className="dash-dd-options">
        <legend className="dash-sr-only">{label}</legend>
        {options.map((option) => (
          <label key={option} className="dash-dd-option">
            <input type="checkbox" checked={selected.includes(option)} onChange={() => toggle(option)} />
            {pills ? <span className={`dash-status dash-status-${option}`}>{humanize(option)}</span> : humanize(option)}
          </label>
        ))}
      </fieldset>
    </Dropdown>
  );
}

interface DateRangeFilterProps {
  label: string;
  from: string;
  /** Exclusive, like the API's `occurred_at < to`. */
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  /** False for reports that need a range; hides Clear. */
  clearable?: boolean;
}

/** A Bahrain business-day range: quick presets plus custom From / Until. */
export function DateRangeFilter({ label, from, to, onChange, clearable = true }: DateRangeFilterProps) {
  const today = bahrainToday();
  const tomorrow = addDays(today, 1);
  const presets: [string, string, string][] = [
    ["Today", today, tomorrow],
    ["Yesterday", addDays(today, -1), today],
    ["Last 7 days", addDays(today, -6), tomorrow],
    ["Last 30 days", addDays(today, -29), tomorrow],
    ["This month", `${today.slice(0, 8)}01`, tomorrow],
  ];

  return (
    <Dropdown
      label={label}
      summary={dayRangeLabel(from, to)}
      active={Boolean(from || to)}
      onClear={clearable ? () => onChange({ from: "", to: "" }) : undefined}
    >
      <div className="dash-dd-presets" role="group" aria-label="Quick ranges">
        {presets.map(([name, presetFrom, presetTo]) => {
          const on = from === presetFrom && to === presetTo;
          return (
            <button
              key={name}
              type="button"
              className={`dash-dd-chip${on ? " dash-dd-chip-on" : ""}`}
              aria-pressed={on}
              onClick={() => onChange({ from: presetFrom, to: presetTo })}
            >
              {name}
            </button>
          );
        })}
      </div>
      <div className="dash-dd-dates">
        <label>
          From
          <input type="date" value={from} max={to || undefined} onChange={(e) => onChange({ from: e.target.value, to })} />
        </label>
        <label>
          Until (not included)
          <input type="date" value={to} min={from || undefined} onChange={(e) => onChange({ from, to: e.target.value })} />
        </label>
      </div>
      <p className="dash-dd-note">Bahrain business days (AST, UTC+3).</p>
    </Dropdown>
  );
}

interface SelectFilterProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

/** Pick exactly one value. */
export function SelectFilter<T extends string | number>({ label, value, options, onChange }: SelectFilterProps<T>) {
  const current = options.find((option) => option.value === value);
  return (
    <Dropdown label={label} summary={current?.label ?? String(value)} active={false}>
      <div className="dash-dd-options" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <label key={String(option.value)} className="dash-dd-option">
            <input type="radio" name={label} checked={option.value === value} onChange={() => onChange(option.value)} />
            {option.label}
          </label>
        ))}
      </div>
    </Dropdown>
  );
}
