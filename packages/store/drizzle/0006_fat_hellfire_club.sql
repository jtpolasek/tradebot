ALTER TABLE "paper_fills" ADD COLUMN "price_source" text;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD COLUMN "price_venue" text;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD COLUMN "price_pool_address" text;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD COLUMN "liquidity_usd" numeric;