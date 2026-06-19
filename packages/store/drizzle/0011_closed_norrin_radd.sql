CREATE TABLE "polymarket_poll_state" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"cursor_timestamp" bigint,
	"cursor_keys" jsonb,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"recorded_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "polymarket_poll_state" ADD CONSTRAINT "polymarket_poll_state_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "polymarket_poll_state_updated_at_idx" ON "polymarket_poll_state" USING btree ("updated_at");