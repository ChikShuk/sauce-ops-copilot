CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"requested_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"claim_token" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_jobs_status_check" CHECK ("enrichment_jobs"."status" in ('pending', 'processing', 'succeeded', 'failed', 'dead_letter'))
);
--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_jobs_finding_id_open_key" ON "enrichment_jobs" USING btree ("finding_id") WHERE "enrichment_jobs"."status" in ('pending', 'processing', 'failed');--> statement-breakpoint
CREATE INDEX "enrichment_jobs_next_attempt_at_idx" ON "enrichment_jobs" USING btree ("next_attempt_at") WHERE "enrichment_jobs"."status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "enrichment_jobs_processing_claimed_at_idx" ON "enrichment_jobs" USING btree ("claimed_at") WHERE "enrichment_jobs"."status" = 'processing';