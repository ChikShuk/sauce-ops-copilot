-- Same reasoning as 0001: Drizzle's $onUpdate only fires for ORM writes, and
-- both of these tables are written by raw SQL — the enrichment_jobs claim and
-- disposition statements, and the app_settings upsert behind the provider
-- toggle. Without the trigger, updated_at would be the row's insert time
-- forever, which is worse than not having the column.
CREATE TRIGGER enrichment_jobs_set_updated_at
BEFORE UPDATE ON "enrichment_jobs"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER app_settings_set_updated_at
BEFORE UPDATE ON "app_settings"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
