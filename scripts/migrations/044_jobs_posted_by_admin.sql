-- 044 An advert an administrator posted on a company's behalf says so (2026-11-12).
--
-- The owner asked for dynamicshub.net's "post a job" from the admin screen. The advert still
-- BELONGS to the company account (`company_user_id`): its "About the company" box, its
-- pipeline and the threads about it all hang off that account, which is why the admin form
-- makes the administrator CHOOSE an existing company rather than filing it under a house
-- profile the way the reference did. This column records the other half of the truth — who
-- actually wrote it — so the company is told, and nobody later reads an advert as the
-- company's own words when an administrator typed it. NULL for every advert the company
-- posted itself, and SET NULL if that administrator's account is ever removed.
ALTER TABLE jobs
  ADD COLUMN posted_by_admin_id INT UNSIGNED NULL AFTER company_user_id,
  ADD CONSTRAINT fk_jobs_posted_by_admin FOREIGN KEY (posted_by_admin_id) REFERENCES users (id) ON DELETE SET NULL;
