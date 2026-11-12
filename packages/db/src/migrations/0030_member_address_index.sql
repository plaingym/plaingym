-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "members" ADD COLUMN "email_address" text GENERATED ALWAYS AS (lower(btrim(email, U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff'))) STORED;--> statement-breakpoint
CREATE INDEX "members_gym_address_idx" ON "members" USING btree ("gym_id","email_address");
