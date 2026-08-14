DROP INDEX "findings_last_event_at_idx";--> statement-breakpoint
CREATE INDEX "findings_last_event_at_idx" ON "findings" USING btree ("last_event_at" desc);