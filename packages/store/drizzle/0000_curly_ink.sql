CREATE TABLE "adaptation_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"rule" text NOT NULL,
	"old_value" text NOT NULL,
	"new_value" text NOT NULL,
	"evidence_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "chain_state" (
	"chain" text PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leader_stats" (
	"wallet_id" uuid NOT NULL,
	"window" text NOT NULL,
	"trades" integer DEFAULT 0 NOT NULL,
	"win_rate" numeric,
	"avg_return_pct" numeric,
	"median_hold_minutes" numeric,
	"realized_pnl_usd" numeric,
	"max_drawdown_pct" numeric,
	"score" numeric,
	"weight" numeric DEFAULT '1' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leader_stats_wallet_id_window_pk" PRIMARY KEY("wallet_id","window")
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decision" text NOT NULL,
	"skip_reason" text,
	"side" text NOT NULL,
	"token_address" text NOT NULL,
	"quote_address" text NOT NULL,
	"qty" numeric NOT NULL,
	"price_usd" numeric NOT NULL,
	"notional_usd" numeric NOT NULL,
	"fee_usd" numeric NOT NULL,
	"slippage_bps" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"voided" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"equity_usd" numeric NOT NULL,
	"cash_usd" numeric NOT NULL,
	"positions_value_usd" numeric NOT NULL,
	"daily_pnl_usd" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"token_address" text NOT NULL,
	"qty" numeric NOT NULL,
	"avg_cost_usd" numeric NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"realized_pnl_usd" numeric DEFAULT '0' NOT NULL,
	"source_wallet_id" uuid
);
--> statement-breakpoint
CREATE TABLE "price_marks" (
	"chain" text NOT NULL,
	"token_address" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"price_usd" numeric NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "price_marks_chain_token_address_ts_pk" PRIMARY KEY("chain","token_address","ts")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"decimals" integer NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "tokens_chain_address_pk" PRIMARY KEY("chain","address")
);
--> statement-breakpoint
CREATE TABLE "trade_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"wallet_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"source" text NOT NULL,
	"side" text NOT NULL,
	"token_in" text NOT NULL,
	"token_out" text NOT NULL,
	"amount_in" numeric NOT NULL,
	"amount_out" numeric NOT NULL,
	"venue" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"block_number" bigint,
	CONSTRAINT "trade_signals_chain_tx_hash_token_in_token_out_unique" UNIQUE("chain","tx_hash","token_in","token_out")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_chain_address_unique" UNIQUE("chain","address")
);
--> statement-breakpoint
ALTER TABLE "leader_stats" ADD CONSTRAINT "leader_stats_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_signal_id_trade_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."trade_signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_source_wallet_id_wallets_id_fk" FOREIGN KEY ("source_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD CONSTRAINT "trade_signals_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;