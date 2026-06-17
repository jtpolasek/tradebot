CREATE INDEX "trade_signals_token_in_idx" ON "trade_signals" USING btree ("token_in");--> statement-breakpoint
CREATE INDEX "trade_signals_token_out_idx" ON "trade_signals" USING btree ("token_out");