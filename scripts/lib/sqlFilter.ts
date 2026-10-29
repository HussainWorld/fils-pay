export function buildWhere(
  filters: Record<string, unknown>,
): { clause: string; values: unknown[]; paramOffset: number } {
  const parts: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [col, val] of Object.entries(filters)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      // FIX H-1: an empty list was skipped (`continue`), silently turning "id is one of nothing" into
      // "no filter at all" — buildDelete("holds", { id: [] }) produced `DELETE FROM holds`. An empty
      // list matches no rows.
      if (val.length === 0) {
        parts.push("FALSE");
        continue;
      }
      values.push(val);
      parts.push(`${col} = ANY($${idx}::uuid[])`);
      idx++;
    } else {
      values.push(val);
      parts.push(`${col} = $${idx}`);
      idx++;
    }
  }
  const clause = parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
  return { clause, values, paramOffset: idx };
}

export function buildDelete(
  table: string,
  filters: Record<string, unknown>,
): { text: string; values: unknown[] } {
  const { clause, values } = buildWhere(filters);
  // FIX H-1: never emit an unscoped DELETE; a caller with no filters gets an error, not an empty table.
  if (clause === "") throw new Error(`buildDelete: refusing to DELETE FROM ${table} without a WHERE clause`);
  return { text: `DELETE FROM ${table} ${clause}`.trim(), values };
}
