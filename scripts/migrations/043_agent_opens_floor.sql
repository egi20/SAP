-- 043 Sales agent opens can never read below the sign-ups they produced (2026-11-11).
--
-- An open is "a session that arrived carrying the agent's code", and every sign-up credited
-- to an agent arrived carrying that code — so each credited sign-up is a proven open. Before
-- the copied /auth/register?a= address was counted (2026-11-09) and before a credited
-- sign-up counted its own missed open (2026-11-11), those visits were credited and never
-- counted, and a row read 27 sign-ups from 10 opens.
--
-- This raises the lifetime counter to the number of credited sign-ups where it is below
-- it. It invents nothing: it is the smallest figure the existing rows prove. Opens that
-- never became a sign-up and were missed are not recoverable and are not guessed at.
-- No dated row is written: the 24-hour figure stays a record of opens actually seen.
UPDATE sales_agents sa
   SET sa.link_opens = GREATEST(sa.link_opens,
         (SELECT COUNT(*) FROM users u WHERE u.sales_agent_id = sa.user_id));
