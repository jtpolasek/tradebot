ALTER TABLE "trade_signals" DROP CONSTRAINT "trade_signals_chain_tx_hash_token_in_token_out_unique";--> statement-breakpoint
ALTER TABLE "trade_signals" ADD CONSTRAINT "trade_signals_chain_tx_hash_token_in_token_out_side_unique" UNIQUE("chain","tx_hash","token_in","token_out","side");
