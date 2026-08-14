-- Drizzle's $onUpdate only fires for ORM writes. Several hot paths in this
-- schema are raw SQL (the racing INSERT + evidence-attach UPDATE on
-- findings, the event_jobs claim UPDATE), which bypass it entirely. This
-- trigger is the actual guarantee that updated_at reflects reality.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER event_jobs_set_updated_at
BEFORE UPDATE ON "event_jobs"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER findings_set_updated_at
BEFORE UPDATE ON "findings"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
