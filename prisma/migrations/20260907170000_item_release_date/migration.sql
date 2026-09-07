-- Merchandise items can be released on their own date inside a lineup. The lineup
-- date remains the default that bulk entry inherits; an item may override it.
ALTER TABLE "merchandise_items"
  ADD COLUMN "release_date" DATE,
  ADD COLUMN "release_date_precision" "DatePrecision";

-- Same paired nullability and normalized anchor rule as lineups: a YEAR is stored on
-- 1 January and a MONTH on the first day, which are anchors and not asserted release days.
ALTER TABLE "merchandise_items"
  ADD CONSTRAINT item_release_date_precision CHECK (
    (release_date IS NULL AND release_date_precision IS NULL) OR
    (release_date IS NOT NULL AND release_date_precision IS NOT NULL AND
      release_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND
      CASE release_date_precision
        WHEN 'YEAR' THEN EXTRACT(MONTH FROM release_date) = 1 AND EXTRACT(DAY FROM release_date) = 1
        WHEN 'MONTH' THEN EXTRACT(DAY FROM release_date) = 1
        WHEN 'DAY' THEN TRUE END)
  );

CREATE INDEX "merchandise_items_release_date_idx" ON "merchandise_items"("release_date");
