CREATE TABLE "runner_health" (
	"id" text PRIMARY KEY DEFAULT 'runner' NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
