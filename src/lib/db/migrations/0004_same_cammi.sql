DROP INDEX "event_jobs_next_attempt_at_idx";--> statement-breakpoint
CREATE INDEX "event_jobs_processing_claimed_at_idx" ON "event_jobs" USING btree ("claimed_at") WHERE "event_jobs"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "event_jobs_next_attempt_at_idx" ON "event_jobs" USING btree ("next_attempt_at") WHERE "event_jobs"."status" in ('pending', 'failed');