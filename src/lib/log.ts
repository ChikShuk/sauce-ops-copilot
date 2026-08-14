// Structured JSON logs with event_id / finding_id correlation IDs, per
// CLAUDE.md. Deliberately a 3-line helper over a logging library: the only
// requirement is one JSON object per line on stdout.
export function logJson(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
