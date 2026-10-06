-- 021 The advert's named sections.
--
-- `description` was one MEDIUMTEXT holding the whole advert. Three more columns is three
-- more places the text of one job lives, which is a cost — so they are OPTIONAL, they
-- render only when they have something in them, and every reader of the advert's prose
-- reads all four or none: `Job.SECTIONS` is the single list, and the matcher's haystack,
-- the search clause, the form and the page are all built from it. A section invisible to
-- the matcher would be the worst version of this: an advert naming EWM only under
-- "Requirements" would score zero against an EWM consultant and nothing would say why.
--
-- NULL means "not filled in", which is why there is no DEFAULT ''. An advert that answered
-- the question with an empty string and one that was never asked are different facts, and
-- the page distinguishes them by rendering neither.

ALTER TABLE jobs
  ADD COLUMN responsibilities MEDIUMTEXT NULL DEFAULT NULL AFTER description,
  ADD COLUMN requirements     MEDIUMTEXT NULL DEFAULT NULL AFTER responsibilities,
  ADD COLUMN what_we_offer    MEDIUMTEXT NULL DEFAULT NULL AFTER requirements;
