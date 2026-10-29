-- FIX: platform_stats.total_processed_fils was INTEGER (int4, max
-- 2,147,483,647 fils = ~2.147M BD) while the volume-tier threshold is
-- 2,000,000,000 fils. Just ~147K BD after the tier switches on, the Go
-- accumulator (int32) wraps to a large negative number: the tier silently
-- switches off again for everyone, and a single batch over ~2.1M BD gross
-- is truncated by int32(). (The comments claiming "INTEGER is 64-bit" are
-- wrong: Postgres INTEGER is always 4 bytes.) ADR-0001: money is BIGINT.
ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;
