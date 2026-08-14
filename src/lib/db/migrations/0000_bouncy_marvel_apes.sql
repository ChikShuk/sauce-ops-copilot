CREATE TABLE "event_jobs" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_jobs_status_check" CHECK ("event_jobs"."status" in ('pending', 'processing', 'succeeded', 'failed', 'dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"restaurant_id" text NOT NULL,
	"order_id" text,
	"event_type" text NOT NULL,
	"issue_class" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"source" text DEFAULT 'simulator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_event_type_check" CHECK ("events"."event_type" in ('delivery_delay', 'complaint', 'refund', 'negative_review'))
);
--> statement-breakpoint
CREATE TABLE "finding_events" (
	"finding_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_events_finding_id_event_id_pk" PRIMARY KEY("finding_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" text NOT NULL,
	"order_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"priority" text,
	"issue" text,
	"summary" text,
	"recommended_actions" jsonb,
	"summary_source" text,
	"extracted_tags" jsonb,
	"event_count" integer DEFAULT 0 NOT NULL,
	"first_event_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_status_check" CHECK ("findings"."status" in ('accepted', 'processing', 'ready', 'failed')),
	CONSTRAINT "findings_priority_check" CHECK ("findings"."priority" is null or "findings"."priority" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "findings_summary_source_check" CHECK ("findings"."summary_source" is null or "findings"."summary_source" in ('llm', 'fallback'))
);
--> statement-breakpoint
CREATE TABLE "operator_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"note" text,
	"actor" text DEFAULT 'operator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_actions_action_type_check" CHECK ("operator_actions"."action_type" in ('mark_reviewed', 'mark_resolved', 'thumbs_down', 'thumbs_up'))
);
--> statement-breakpoint
ALTER TABLE "event_jobs" ADD CONSTRAINT "event_jobs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_actions" ADD CONSTRAINT "operator_actions_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_jobs_next_attempt_at_idx" ON "event_jobs" USING btree ("next_attempt_at") WHERE "event_jobs"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "events_restaurant_id_event_id_key" ON "events" USING btree ("restaurant_id","event_id");--> statement-breakpoint
CREATE INDEX "events_order_id_idx" ON "events" USING btree ("order_id") WHERE "events"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "events_restaurant_issue_class_occurred_at_idx" ON "events" USING btree ("restaurant_id","issue_class","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_events_event_id_key" ON "finding_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "findings_status_idx" ON "findings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "findings_priority_idx" ON "findings" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "findings_last_event_at_idx" ON "findings" USING btree ("last_event_at");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_restaurant_id_open_key" ON "findings" USING btree ("restaurant_id") WHERE "findings"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "operator_actions_finding_id_idx" ON "operator_actions" USING btree ("finding_id");