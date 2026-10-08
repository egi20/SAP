-- 027 The tax advisory introduction.
--
-- THE REFUSAL THAT DEFINES THIS FEATURE comes first, because the schema is where it is
-- easiest to smuggle back in. DynamicsHub ships a calculator: it takes the gross and net a
-- visitor types, applies `newNet = gross - (gross * percentRate / 100 + fixedFee)` with
-- `percentRate` defaulting to 5 and EDITABLE BY AN ADMINISTRATOR, and returns a monthly
-- saving, an annual saving and a percentage increase. That arithmetic asserts somebody's
-- entire burden becomes five per cent of gross — no jurisdiction, no entity type, no VAT
-- position, no social security floor, no accountant's fee — and the figure it shows is a
-- marketing dial with a number on it. Its table then stores `estimated_monthly_savings`
-- POSTED BACK FROM THE BROWSER.
--
-- There is no such column here and there is no such endpoint. A test scans the config, the
-- model, the route and the view for anything saving-shaped, which is the same test the
-- success stories carry, because this is the third time the same calculator has tried to
-- arrive wearing a different hat.
--
-- WHAT THIS IS: an introduction. Somebody says what their situation is and a specialist
-- who works in their jurisdiction gets in touch. Six fields, because a first conversation
-- needs six things; everything else is asked by the specialist, in that conversation,
-- under their own engagement terms — which is also the only place a professional duty of
-- confidentiality actually attaches. It does not attach here.
--
-- ONE TABLE AND ONE QUEUE, which is the rule migration 018 was written about. A tax
-- enquiry is the same object as a contact message — a person writing in and expecting an
-- answer — differing in which fields the form asked for. The three things that looked like
-- they needed a second table did not:
--
--   * "introduced" is not a queue state, it is a FACT WITH A DATE, so it is a column and
--     the shared new/open/closed vocabulary is untouched;
--   * the retention rule is a WHERE on the purge, not a reason to split a table;
--   * "one open enquiry per address" is a generated column under a unique key, scoped to
--     this kind, exactly as `pending_job_id` scopes one live offer per advert.

ALTER TABLE enquiries
  MODIFY COLUMN kind ENUM('contact', 'issue', 'tax_advisory') NOT NULL;

ALTER TABLE enquiries
  -- Routing information, not a diagnosis: between them they decide who reads this, and
  -- nothing else. Both are validated against config/taxAdvisory.js.
  ADD COLUMN topic          VARCHAR(32) NULL DEFAULT NULL AFTER page_url,
  ADD COLUMN arrangement    VARCHAR(32) NULL DEFAULT NULL AFTER topic,
  -- Refused rather than truncated at two characters: `ALB` sliced to `AL` is Albania
  -- becoming Albania by luck and `AUT` is Austria becoming Australia.
  ADD COLUMN country        CHAR(2)     NULL DEFAULT NULL AFTER arrangement,

  -- The moment the Hub's involvement ends. A date rather than a status, because it is a
  -- fact about what happened and not a place in a queue — and because `introduced` on a
  -- contact message would be a state that screen has no meaning for.
  ADD COLUMN introduced_at  DATETIME    NULL DEFAULT NULL AFTER handled_at,

  -- Which privacy notice this person was shown. Stamped for this kind only: the tax form
  -- states what is kept and for how long, and the other two forms make no such promise.
  -- "Not asked" and "answered" stay different facts, as they do for the issue fields.
  ADD COLUMN privacy_version VARCHAR(32) NULL DEFAULT NULL AFTER country;

-- One OPEN tax enquiry per address, held by the schema rather than by an `if`.
-- NULL for every other kind and for every closed row, and in SQL a NULL never equals
-- another NULL — so any number of settled enquiries coexist and a second live one from the
-- same address is refused by the database. Same technique as `cert_key` in migration 002.
ALTER TABLE enquiries
  ADD COLUMN open_tax_email VARCHAR(190)
    AS (IF(kind = 'tax_advisory' AND status <> 'closed', email, NULL)) STORED,
  ADD UNIQUE KEY uq_enquiries_open_tax (open_tax_email);

-- The shape rule, extended rather than relaxed. A rule held only by the handler that
-- happens to be correct today is the shape this codebase keeps warning about.
ALTER TABLE enquiries DROP CONSTRAINT chk_enquiry_shape;

ALTER TABLE enquiries
  ADD CONSTRAINT chk_enquiry_shape CHECK (
    (kind = 'issue'
       AND issue_type IS NOT NULL AND severity IS NOT NULL
       AND topic IS NULL AND arrangement IS NULL AND country IS NULL)
    OR (kind = 'contact'
       AND issue_type IS NULL AND severity IS NULL
       AND topic IS NULL AND arrangement IS NULL AND country IS NULL)
    OR (kind = 'tax_advisory'
       AND issue_type IS NULL AND severity IS NULL
       AND topic IS NOT NULL AND arrangement IS NOT NULL AND country IS NOT NULL)
  );
