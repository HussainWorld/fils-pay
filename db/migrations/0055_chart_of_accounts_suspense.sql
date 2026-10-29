-- Additional suspense accounts for future reconciliation lanes.

-- Fixed: chart_of_accounts (0007) has columns (id, name, kind), not
-- (code, name, account_type, description), and kind only allows
-- asset/liability/revenue. 'suspense' -> 'asset', matching the existing
-- scheme_rounding_residue suspense account in 0007. Descriptions kept as
-- comments since there is no column for them.
INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  -- Captures rounding differences between fils and scheme-file BD amounts.
  ('fx_rounding_difference', 'FX Rounding Difference', 'asset'),
  -- Holds chargeback amounts pending acquirer confirmation.
  ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;
