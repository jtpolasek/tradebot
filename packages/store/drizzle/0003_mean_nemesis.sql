ALTER TABLE "trade_signals" ADD COLUMN "decode_status" text DEFAULT 'decoded' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "confidence" numeric;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "reason" text;