CREATE TABLE "prospect_discovery_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"promoted_last_run" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"address" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"user_name" text,
	"x_username" text,
	"pnl_usd" double precision,
	"vol_usd" double precision,
	"pnl_per_vol" double precision,
	"trade_count" integer,
	"last_trade_ts" bigint,
	"score" double precision,
	"verdict" text NOT NULL,
	"reject_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_wallet_id" uuid
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "auto_added" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "human_touched" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_promoted_wallet_id_wallets_id_fk" FOREIGN KEY ("promoted_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;