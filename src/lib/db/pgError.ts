const UNIQUE_VIOLATION = "23505";
// Drizzle wraps driver errors one level deep (DrizzleQueryError -> cause ->
// PostgresError). Walk a little further than that in case a future path
// double-wraps, but stay bounded and cycle-guarded.
const MAX_CAUSE_DEPTH = 5;

// Matches a Postgres unique violation on a SPECIFIC named constraint.
//
// Never matches on err.message: message text is a driver/server formatting
// detail, and matching it would silently start passing or failing on a version
// bump. SQLSTATE plus the constraint name is the contract.
//
// Verified against a real violation rather than inferred from the driver
// source: the error arrives as DrizzleQueryError at depth 0 (keys: query,
// params, cause) wrapping PostgresError at depth 1, which carries
// code = "23505" and constraint_name = "<name>" (snake_case; a `constraint`
// field does not exist). The shape is identical inside db.transaction and for
// a bare db.execute, and a foreign-key violation surfaces as 23503 with its own
// constraint_name — so requiring BOTH fields keeps unrelated violations from
// being swallowed by a retry meant for one specific race.
export function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);

    const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === UNIQUE_VIOLATION && candidate.constraint_name === constraintName) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
