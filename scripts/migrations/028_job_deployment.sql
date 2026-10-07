-- 028 Which SAP an advert is for, and how the programme gets there.
--
-- The first thing anybody reading an SAP advert in 2026 wants to know is which SAP: a
-- Public Edition role (GROW) and a Private Edition role (RISE) differ in what can be built,
-- how often it is upgraded and what extensibility is allowed, and ECC work is a different
-- job again. The board had no way to say it or to filter on it.
--
-- And how the programme gets there — greenfield, brownfield or selective data transition
-- — which the estimator already prices differently and which decides what the consultant
-- spends the year doing. The values are the estimator's own TRANSITION_APPROACHES keys,
-- so a quote and an advert use the same three words.
--
-- Both NULL by default and NULL means "not stated": support work has no transition, and
-- a permanent hire may span deployments. The mirrors are `config/sapDeployments.js`, and a
-- unit test compares each against this file.

ALTER TABLE jobs
  ADD COLUMN deployment ENUM('public-cloud', 'private-cloud', 'on-premise', 'ecc')
    NULL DEFAULT NULL AFTER activate_phase,
  ADD COLUMN transition_approach ENUM('greenfield', 'brownfield', 'selective')
    NULL DEFAULT NULL AFTER deployment,
  ADD KEY idx_jobs_deployment (deployment, status);
