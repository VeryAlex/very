-- Very Delivery CRM V2 additive update: categories for shared quick replies
-- Existing notes and quick replies from migration 004 are preserved.
ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'Общие';

CREATE INDEX IF NOT EXISTS quick_replies_category_title_idx
  ON quick_replies(category, title, id);
