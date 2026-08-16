ALTER TABLE "findings" ADD COLUMN "llm_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "llm_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "llm_cost_micros_usd" bigint;