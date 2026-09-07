-- CreateTable
CREATE TABLE "lineup_sources" (
    "id" UUID NOT NULL,
    "lineup_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "source_type" "SourceType" NOT NULL DEFAULT 'OTHER',
    "url" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lineup_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lineup_sources_lineup_id_url_key" ON "lineup_sources"("lineup_id", "url");

-- CreateIndex
CREATE INDEX "lineups_created_at_idx" ON "lineups"("created_at");

-- CreateIndex
CREATE INDEX "lineups_manufacturer_idx" ON "lineups"("manufacturer");

-- CreateIndex
CREATE INDEX "lineups_status_archived_at_idx" ON "lineups"("status", "archived_at");

-- AddForeignKey
ALTER TABLE "lineup_sources" ADD CONSTRAINT "lineup_sources_lineup_id_fkey" FOREIGN KEY ("lineup_id") REFERENCES "lineups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
