DELETE FROM drafts
WHERE candidate_id IN (
  SELECT id FROM candidates
  WHERE source_name LIKE '%チラシ%' OR title_ja LIKE '%チラシAI%'
);
--> statement-breakpoint
DELETE FROM candidates
WHERE source_name LIKE '%チラシ%' OR title_ja LIKE '%チラシAI%';
--> statement-breakpoint
DELETE FROM scan_runs
WHERE source_url LIKE 'https://www.shimamura.gr.jp/shimamura/flier/%';
--> statement-breakpoint
ALTER TABLE candidates ADD COLUMN availability TEXT NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE candidates ADD COLUMN variant_summary TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE candidates ADD COLUMN source_item_code TEXT;
