import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listSettlementBatches } from "../../api/settlement.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dateTime } from "../../format.js";
import type { SettlementBatchDto, SettlementBatchStatus } from "../../types.js";
import { DateRangeFilter, MultiSelectFilter } from "../../components/FilterDropdown.js";

const STATUSES: SettlementBatchStatus[] = ["open", "closed", "paid"];
const PAGE_SIZE = 25;

/**
 * `GET /v1/settlement/batches` — `requireMerchantAuth` with no role
 * restriction — a batch list is not as sensitive as the reconciliation
 * report.
 *
 * `from`/`to` bound `batch_date`, a plain DATE column, so the raw YYYY-MM-DD
 * value from the date input goes through unchanged — no instant conversion,
 * because there is no timezone in the column to convert against.
 */
/** Filters by batch_date, which is a Bahrain business date. */
export function SettlementBatchListPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<SettlementBatchStatus[]>([]);
  const [batches, setBatches] = useState<SettlementBatchDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listSettlementBatches({
          from: from || undefined,
          to: to || undefined,
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setBatches((previous) => (cursor ? [...previous, ...result.batches] : result.batches));
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [from, to, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <section>
      <h1>Settlement batches</h1>

      <div className="dash-toolbar">
        <MultiSelectFilter label="Status" options={STATUSES} selected={statuses} onChange={setStatuses} />
        <DateRangeFilter
          label="Batch date"
          from={from}
          to={to}
          onChange={(range) => {
            setFrom(range.from);
            setTo(range.to);
          }}
        />
      </div>

      {error ? <p className="dash-error">{error}</p> : null}

      <table className="dash-table">
        <thead>
          <tr>
            <th>Batch date</th>
            <th>Status</th>
            <th>Gross</th>
            <th>Fee</th>
            <th>Net payout</th>
            <th>Closed</th>
            <th>Paid</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td>
                <Link to={`/dashboard/settlement/${batch.id}`}>{batch.batchDate}</Link>
              </td>
              <td>
                <span className={`dash-status dash-status-${batch.status}`}>{batch.status}</span>
              </td>
              <td>{bhd(batch.grossFils)}</td>
              <td>{bhd(batch.feeFils)}</td>
              <td>{bhd(batch.netPayoutFils)}</td>
              <td>{dateTime(batch.closedAt)}</td>
              <td>{dateTime(batch.paidAt)}</td>
            </tr>
          ))}
          {batches.length === 0 && !loading ? (
            <tr>
              <td colSpan={7}>No settlement batches match these filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>Loading...</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
