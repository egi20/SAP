-- 037 Four topic challenges join the scored games (owner, 2026-10-22): SAP Fiori, SAP HANA,
-- SAP Sapphire and SAP & AI agents. `game` mirrors the scored keys in config/games.js; a unit
-- test compares the two, walking every migration so this widening is the definition it reads.
ALTER TABLE game_attempts
  MODIFY game ENUM('match', 'scenario', 'codequiz', 'bughunter', 'wordsearch',
                   'fiori', 'hana', 'sapphire', 'aiagents') NOT NULL;
