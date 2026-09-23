CREATE TABLE "table_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venue_tables" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "table_groups" ADD CONSTRAINT "table_groups_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "table_groups_venue_id_idx" ON "table_groups" USING btree ("venue_id");--> statement-breakpoint
ALTER TABLE "venue_tables" ADD CONSTRAINT "venue_tables_group_id_table_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."table_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "venue_tables_group_id_idx" ON "venue_tables" USING btree ("group_id");