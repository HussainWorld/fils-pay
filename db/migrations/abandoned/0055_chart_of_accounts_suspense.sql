-- Additional suspense accounts for future reconciliation lanes.

INSERT INTO chart_of_accounts (code, name, account_type, description)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference', 'suspense',
   'Captures rounding differences between fils and scheme-file BD amounts.'),
  ('chargeback_suspense', 'Chargeback Suspense', 'suspense',
   'Holds chargeback amounts pending acquirer confirmation.')
ON CONFLICT (code) DO NOTHING;
