import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listTransactions } from "../../api/transactions.js";
import { describeError } from "../../api/client.js";
import { DateRangeFilter, MultiSelectFilter } from "../../components/FilterDropdown.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dash, dateTime, dayStartIso } from "../../format.js";
import { classNames, pluralize, truncateMiddle } from "../../utils/helpers.js";
import type { TransactionDto, TransactionStatus } from "../../types.js";

const STATUSES: TransactionStatus[] = [
  "authorized",
  "captured",
  "partially_captured",
  "voided",
  "partially_refunded",
  "refunded",
  "chargeback",
];

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * `GET /v1/transactions`. Every control here is a real server-side
 * query param — nothing fetches an unfiltered page and narrows it in the
 * browser, which would both lie about the result count and break pagination.
 */
// from/to are Bahrain business-day starts, see dayStartIso (FIX TZ-1)
export function TransactionListPage() {
  const [statuses, setStatuses] = useState<TransactionStatus[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce only the text box — the status/date dropdowns fire immediately,
  // since those are discrete choices, not a stream of keystrokes.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listTransactions({
          status: statuses.length > 0 ? statuses : undefined,
          from: dayStartIso(from),
          to: dayStartIso(to),
          search: search || undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setTransactions((previous) =>
          cursor ? [...previous, ...result.transactions] : result.transactions,
        );
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [statuses, from, to, search],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const filtered = statuses.length > 0 || from !== "" || to !== "" || searchInput !== "";

  function clearFilters(): void {
    setStatuses([]);
    setFrom("");
    setTo("");
    setSearchInput("");
  }

  return (
    <section>
      <h1>Transactions</h1>

      <div className="dash-toolbar" role="search">
        <label className="dash-search">
          <span className="dash-sr-only">Search transactions</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Reference, acquirer reference, or transaction id"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <MultiSelectFilter label="Status" options={STATUSES} selected={statuses} onChange={setStatuses} />
        {/* `to` is exclusive, because the endpoint's own predicate is
            `occurred_at < to`; the dropdown shows the last included day and
            sends the exclusive bound, so this page and the API agree. */}
        <DateRangeFilter
          label="Date"
          from={from}
          to={to}
          onChange={(range) => {
            setFrom(range.from);
            setTo(range.to);
          }}
        />
        {filtered ? (
          <button type="button" className="dash-toolbar-reset" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>

      {error ? <p className="dash-error">{error}</p> : null}

      <p>{pluralize(transactions.length, "transaction")} loaded</p>

      <table className="dash-table">
        <thead>
          <tr>
            <th>Occurred</th>
            <th>Reference</th>
            <th>Status</th>
            <th>Authorized</th>
            <th>Captured</th>
            <th>Acquirer reference</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((txn) => (
            <tr key={txn.id}>
              <td>
                <Link to={`/dashboard/transactions/${txn.id}`}>{dateTime(txn.occurredAt)}</Link>
              </td>
              <td>{dash(txn.reference)}</td>
              <td>
                <span className={classNames("dash-status", `dash-status-${txn.status}`)}>{txn.status}</span>
              </td>
              <td>{bhd(txn.amountFils)}</td>
              <td>{bhd(txn.capturedFils)}</td>
              <td>
                <code>{truncateMiddle(txn.acquirerReference, 20)}</code>
              </td>
            </tr>
          ))}
          {transactions.length === 0 && !loading ? (
            <tr>
              <td colSpan={6}>No transactions match these filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>Loading...</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
