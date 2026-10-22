-- 039 Three arcade games join the scored games (owner, 2026-10-22): SAP Memory, Lightning and
-- SAP Snake. Played in the browser, scored on the server from state the server kept — see the
-- arcade section of config/games.js. `game` mirrors the scored keys; a unit test walks every
-- migration and compares the last definition with the code.
ALTER TABLE game_attempts
  MODIFY game ENUM('match', 'scenario', 'codequiz', 'bughunter', 'wordsearch',
                   'fiori', 'hana', 'sapphire', 'aiagents',
                   'memory', 'lightning', 'snake') NOT NULL;
