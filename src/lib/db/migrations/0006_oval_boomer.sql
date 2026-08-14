ALTER TABLE "findings" ADD COLUMN "cited_event_ids" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "llm_model" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "enriched_at" timestamp with time zone;