'use strict';

const crypto = require('crypto');

/**
 * The SAP games beside the daily challenge, and the rule that keeps them honest.
 *
 * Until 2026-10-21 there was one game, and `config/challenges.js` says why: DynamicsHub's
 * other eight are client-authoritative — the browser posts `{ score, gameDate }` and every
 * answer ships in the page — so porting them would have been porting that bug eight times.
 * The owner asked for the rest on 2026-10-21. They arrive here WITHOUT the bug, which is
 * the price of having them:
 *
 *   - A SCORED game (match, scenario, code quiz, bug hunter, word search) is graded on the
 *     server against a set the browser never sees the key to. The page posts what was
 *     chosen; `grade()` decides the score; the date is the server's; one attempt per game
 *     per day is a unique key (migration 033). Same shape as the daily challenge, end to end.
 *   - A PRACTICE game (flashcards, typing) scores nothing, stores nothing and pays nothing.
 *     A typing speed is measured by the browser's clock and can only ever be what the
 *     browser says it was, so it is not put on a board or into the points ledger. That is
 *     the one thing the reference's typing game cannot be made honest about, so it is
 *     practice here rather than a competition.
 *   - Streak check-in is not a game: the streak is derived from attempt dates already.
 *
 * Every set is derived from the DATE, so everybody gets the same set on a day, a reload
 * changes nothing, and a disputed score can be regraded from the stored choices. Banks grow
 * forward only — an item added later carries `since` — for the reason `activeOn` in
 * config/challenges.js gives: a change to the bank reshuffles every day, played ones too.
 *
 * The content is SAP's own vocabulary. A transaction code or table named here must be one
 * that exists in S/4HANA with that meaning; a wrong one is a wrong fact taught to somebody
 * preparing for a project. Where S/4HANA changed the answer (BP replacing XK01/XD01,
 * MATDOC beside MSEG) the bank says so.
 */

/* ------------------------------------------------------------------ catalogue */

const GAMES = Object.freeze([
  {
    key: 'match', title: 'Code match', icon: 'bi-link-45deg', scored: true, perDay: 6,
    blurb: 'Six transaction codes and tables. Match each one to what it does.'
  },
  {
    key: 'scenario', title: 'Project scenarios', icon: 'bi-kanban', scored: true, perDay: 4,
    blurb: 'Situations from real SAP projects. Pick what a good consultant does next.'
  },
  {
    key: 'codequiz', title: 'ABAP output', icon: 'bi-code-slash', scored: true, perDay: 4,
    blurb: 'Read a few lines of ABAP and say what they produce.'
  },
  {
    key: 'bughunter', title: 'Bug hunter', icon: 'bi-bug', scored: true, perDay: 3,
    blurb: 'Each ABAP snippet has one line that is wrong. Find it.'
  },
  {
    key: 'wordsearch', title: 'Word search', icon: 'bi-grid-3x3', scored: true, perDay: 6,
    blurb: 'Six SAP terms hidden in a grid. Each comes with a clue.'
  },
  {
    key: 'flashcards', title: 'Flashcards', icon: 'bi-card-text', scored: false, perDay: 12,
    blurb: 'Twelve codes and terms a day to revise. Practice only — nothing is scored.'
  },
  {
    key: 'typing', title: 'Typing practice', icon: 'bi-keyboard', scored: false, perDay: 1,
    blurb: 'Type a short SAP passage. Your speed stays in your browser.'
  }
]);

const SCORED_KEYS = Object.freeze(GAMES.filter((g) => g.scored).map((g) => g.key));

/**
 * Points for one game: two for a perfect set, one for at least half, nothing below.
 * Five games a day is at most ten points — the same principle as the challenge's one point
 * a correct answer: a game should nudge a standing, never build one.
 */
function pointsFor(score, total) {
  if (!total) return 0;
  if (score === total) return 2;
  return score * 2 >= total ? 1 : 0;
}

/* ------------------------------------------------------------------ banks */

/** Code match and flashcards: an SAP code and what it is. */
const CODES = Object.freeze([
  { id: 'tc-va01', term: 'VA01', meaning: 'Create a sales order', kind: 'Transaction' },
  { id: 'tc-vl01n', term: 'VL01N', meaning: 'Create an outbound delivery', kind: 'Transaction' },
  { id: 'tc-vf01', term: 'VF01', meaning: 'Create a billing document', kind: 'Transaction' },
  { id: 'tc-me51n', term: 'ME51N', meaning: 'Create a purchase requisition', kind: 'Transaction' },
  { id: 'tc-me21n', term: 'ME21N', meaning: 'Create a purchase order', kind: 'Transaction' },
  { id: 'tc-migo', term: 'MIGO', meaning: 'Post a goods movement (receipt, issue, transfer)', kind: 'Transaction' },
  { id: 'tc-miro', term: 'MIRO', meaning: 'Enter a supplier invoice against a purchase order', kind: 'Transaction' },
  { id: 'tc-mrbr', term: 'MRBR', meaning: 'Release supplier invoices blocked for payment', kind: 'Transaction' },
  { id: 'tc-mm01', term: 'MM01', meaning: 'Create a material master', kind: 'Transaction' },
  { id: 'tc-bp', term: 'BP', meaning: 'Maintain a business partner — customers and suppliers in S/4HANA', kind: 'Transaction' },
  { id: 'tc-fb50', term: 'FB50', meaning: 'Enter a G/L account document', kind: 'Transaction' },
  { id: 'tc-fb08', term: 'FB08', meaning: 'Reverse a posted accounting document', kind: 'Transaction' },
  { id: 'tc-f110', term: 'F110', meaning: 'Run the automatic payment program', kind: 'Transaction' },
  { id: 'tc-fs00', term: 'FS00', meaning: 'Maintain a G/L account centrally', kind: 'Transaction' },
  { id: 'tc-ob52', term: 'OB52', meaning: 'Open and close posting periods', kind: 'Transaction' },
  { id: 'tc-ks01', term: 'KS01', meaning: 'Create a cost center', kind: 'Transaction' },
  { id: 'tc-ko01', term: 'KO01', meaning: 'Create an internal order', kind: 'Transaction' },
  { id: 'tc-co01', term: 'CO01', meaning: 'Create a production order', kind: 'Transaction' },
  { id: 'tc-md04', term: 'MD04', meaning: 'Display the stock/requirements list', kind: 'Transaction' },
  { id: 'tc-cs01', term: 'CS01', meaning: 'Create a bill of material', kind: 'Transaction' },
  { id: 'tc-iw31', term: 'IW31', meaning: 'Create a maintenance order', kind: 'Transaction' },
  { id: 'tc-se38', term: 'SE38', meaning: 'ABAP Editor — write and run programs', kind: 'Transaction' },
  { id: 'tc-se11', term: 'SE11', meaning: 'ABAP Dictionary — tables, views, data elements', kind: 'Transaction' },
  { id: 'tc-se37', term: 'SE37', meaning: 'Function Builder — function modules', kind: 'Transaction' },
  { id: 'tc-se24', term: 'SE24', meaning: 'Class Builder — ABAP classes', kind: 'Transaction' },
  { id: 'tc-sm37', term: 'SM37', meaning: 'Overview of background jobs and their logs', kind: 'Transaction' },
  { id: 'tc-su01', term: 'SU01', meaning: 'Maintain users', kind: 'Transaction' },
  { id: 'tc-pfcg', term: 'PFCG', meaning: 'Maintain roles and their authorizations', kind: 'Transaction' },
  { id: 'tc-su53', term: 'SU53', meaning: 'Show the last failed authorization check', kind: 'Transaction' },
  { id: 'tc-st22', term: 'ST22', meaning: 'Analyse ABAP runtime errors (short dumps)', kind: 'Transaction' },
  { id: 'tc-st05', term: 'ST05', meaning: 'Performance trace, including the SQL trace', kind: 'Transaction' },
  { id: 'tc-stms', term: 'STMS', meaning: 'Transport Management System — import transports', kind: 'Transaction' },
  { id: 'tc-sm59', term: 'SM59', meaning: 'Configure RFC destinations', kind: 'Transaction' },
  { id: 'tc-we02', term: 'WE02', meaning: 'Display IDocs', kind: 'Transaction' },
  { id: 'tc-bd87', term: 'BD87', meaning: 'Status monitor for ALE messages — reprocess IDocs', kind: 'Transaction' },
  { id: 'tc-spro', term: 'SPRO', meaning: 'Customizing — the Implementation Guide (IMG)', kind: 'Transaction' },
  { id: 'tb-acdoca', term: 'ACDOCA', meaning: 'Universal Journal line items', kind: 'Table' },
  { id: 'tb-bkpf', term: 'BKPF', meaning: 'Accounting document header', kind: 'Table' },
  { id: 'tb-mara', term: 'MARA', meaning: 'General material data', kind: 'Table' },
  { id: 'tb-marc', term: 'MARC', meaning: 'Plant data for a material', kind: 'Table' },
  { id: 'tb-matdoc', term: 'MATDOC', meaning: 'Material documents in S/4HANA', kind: 'Table' },
  { id: 'tb-vbak', term: 'VBAK', meaning: 'Sales document header', kind: 'Table' },
  { id: 'tb-vbap', term: 'VBAP', meaning: 'Sales document item', kind: 'Table' },
  { id: 'tb-ekko', term: 'EKKO', meaning: 'Purchasing document header', kind: 'Table' },
  { id: 'tb-ekpo', term: 'EKPO', meaning: 'Purchasing document item', kind: 'Table' },
  { id: 'tb-but000', term: 'BUT000', meaning: 'Business partner general data', kind: 'Table' },
  { id: 'tb-t001', term: 'T001', meaning: 'Company codes', kind: 'Table' },
  { id: 'tb-t001w', term: 'T001W', meaning: 'Plants', kind: 'Table' }
]);

/** Project scenarios: multiple choice, one clearly right answer. */
const SCENARIOS = Object.freeze([
  {
    id: 'sc-credit-block',
    prompt: 'A sales order cannot be delivered. The delivery log says the customer is over their credit limit. What resolves it properly?',
    options: [
      'A credit controller reviews the order and releases the credit block, or the limit is changed',
      'Delete the order item and create it again',
      'Change the delivering plant',
      'Run MRP for the material'
    ],
    answer: 0,
    explain: 'The block is a control, not an error. Credit management holds the order until somebody with the authority releases it or changes the limit — recreating the item would just block again.'
  },
  {
    id: 'sc-price-variance',
    prompt: 'A supplier invoice is 8% above the purchase order price, beyond the tolerance. What happens in MIRO?',
    options: [
      'It cannot be entered at all',
      'It posts, blocked for payment, and is released later (MRBR) once the variance is settled',
      'It posts and pays at the purchase order price',
      'The purchase order price is updated automatically'
    ],
    answer: 1,
    explain: 'Logistics invoice verification posts the invoice with a payment block when a tolerance is exceeded. The variance is resolved with the buyer, and the block is released in MRBR.'
  },
  {
    id: 'sc-closed-period',
    prompt: 'Accounting must post a correction to last month, but the posting is refused: the period is closed. Where is that controlled?',
    options: [
      'In the user master (SU01)',
      'In the posting period variant, opened and closed in OB52',
      'In the fiscal year variant',
      'In the G/L account master'
    ],
    answer: 1,
    explain: 'Open periods are maintained per posting period variant in OB52, by account type and range. Opening one is a finance decision, usually for a named user group and a short window.'
  },
  {
    id: 'sc-fit-gap',
    prompt: 'In a fit-to-standard workshop the business needs something the standard process does not do. What is the SAP Activate answer?',
    options: [
      'Modify the standard SAP code so it does',
      'Record it as a delta requirement and look first for configuration, a key-user extension or a side-by-side extension on SAP BTP',
      'Drop the requirement',
      'Postpone it until after go-live without recording it'
    ],
    answer: 1,
    explain: 'Clean core: the gap goes on the backlog, and the order of preference is configuration, then in-app key-user extensibility, then side-by-side on BTP. Modifying SAP code is what makes every later upgrade expensive.'
  },
  {
    id: 'sc-mrp-nd',
    prompt: 'MRP runs, but no planned orders are ever created for one material despite open demand. What is the first thing to check?',
    options: [
      'The material\'s MRP type — ND means no planning',
      'The customer\'s credit limit',
      'The G/L account of the material',
      'The printer settings for the plant'
    ],
    answer: 0,
    explain: 'MRP type ND excludes the material from planning entirely. It is a field on the MRP 1 view of the material master, per plant, and it is the most common reason a material "does nothing" in MRP.'
  },
  {
    id: 'sc-no-auth',
    prompt: 'A user reports "You are not authorized" in a transaction. What gives the fastest first diagnosis?',
    options: [
      'SU53, run by the user right after the failure',
      'Reinstalling the SAP GUI',
      'ST22',
      'Giving the user SAP_ALL'
    ],
    answer: 0,
    explain: 'SU53 shows the authorization object and values of the check that just failed. With that, the role can be corrected in PFCG — granting SAP_ALL fixes the symptom and breaks segregation of duties.'
  },
  {
    id: 'sc-idoc-51',
    prompt: 'An inbound IDoc stands in status 51. What does that mean, and what is the usual fix?',
    options: [
      'It was never received — ask the sender to resend',
      'The application document was not posted — correct the cause and reprocess it, for example in BD87',
      'It posted successfully',
      'It is waiting for a background job and needs nothing'
    ],
    answer: 1,
    explain: 'Status 51 is "application document not posted": the IDoc arrived, but posting failed — missing master data, a locked document, a wrong value. Fix the cause, then reprocess it rather than asking for a resend.'
  },
  {
    id: 'sc-reverse-fi',
    prompt: 'An FI document was posted with the wrong amount. How is it corrected?',
    options: [
      'Change the amount in the posted document',
      'Delete the document',
      'Reverse it (FB08) and post it again correctly',
      'Change the G/L account balance directly'
    ],
    answer: 2,
    explain: 'Amounts on a posted document cannot be changed — that is what makes a ledger auditable. It is reversed, which creates a reversal document linked to the original, and posted again.'
  },
  {
    id: 'sc-parallel-ledgers',
    prompt: 'A group reports under IFRS and also needs local GAAP books. What is the standard S/4HANA design?',
    options: [
      'Two separate company codes for the same entity',
      'A leading ledger plus a non-leading ledger, posting in parallel',
      'A spreadsheet adjustment at month end',
      'Two different charts of accounts in one company code'
    ],
    answer: 1,
    explain: 'Parallel ledgers: the leading ledger (usually 0L) for the group standard and a non-leading ledger for local GAAP, both in the Universal Journal. Postings that differ go only to the ledger they apply to.'
  },
  {
    id: 'sc-transport-order',
    prompt: 'A transport fails in the quality system with a syntax error about an object that does not exist there. What is the likely cause?',
    options: [
      'The quality system needs more memory',
      'It depends on an earlier transport that has not been imported yet',
      'The user is not authorized',
      'The client is wrong'
    ],
    answer: 1,
    explain: 'Transports carry objects, not their dependencies. If a change refers to an object released in another transport, the import order matters — import the earlier one, then this.'
  },
  {
    id: 'sc-migration-tool',
    prompt: 'A new S/4HANA implementation needs to load open items, materials and business partners from the old system. Which SAP tool is built for it?',
    options: [
      'The SAP S/4HANA Migration Cockpit ("Migrate Your Data")',
      'SM37',
      'SE16N',
      'Manual entry in each transaction'
    ],
    answer: 0,
    explain: 'The Migration Cockpit provides predefined migration objects with templates or staging tables, mapping and simulation, which is why it is the default for a new implementation.'
  },
  {
    id: 'sc-slow-report',
    prompt: 'A custom report has become very slow since data volume grew. What is a sound first step?',
    options: [
      'Add more application servers',
      'Trace it with ST05 or the ABAP profiler to see which statements cost the time',
      'Rewrite it from scratch',
      'Run it only at night and say nothing'
    ],
    answer: 1,
    explain: 'Measure before changing. A SQL trace usually shows the pattern — a SELECT in a loop, a missing index, reading whole tables — and the fix follows from what it finds.'
  },
  {
    id: 'sc-standard-price',
    prompt: 'A material is valued at standard price (price control S). A goods receipt arrives at a higher purchase price. Where does the difference go?',
    options: [
      'Into the stock value of the material',
      'To a price difference account',
      'Nowhere — the receipt is refused',
      'To the supplier\'s account as a credit'
    ],
    answer: 1,
    explain: 'With standard price, stock is always valued at the standard; any difference between the purchase price and the standard posts to a price difference account. With moving average (V) it would change the stock value instead.'
  },
  {
    id: 'sc-custom-code',
    prompt: 'In a brownfield conversion, how does a team find which custom ABAP code will break on S/4HANA?',
    options: [
      'Run the custom code checks in the ABAP Test Cockpit with the S/4HANA readiness check variant',
      'Wait for the go-live and fix the dumps',
      'Delete all custom code',
      'Check it by reading every program by hand'
    ],
    answer: 0,
    explain: 'The ATC with the S/4HANA readiness checks finds code affected by simplification items — changed tables, removed transactions, data model changes — before the conversion, while there is time to plan it.'
  },
  {
    id: 'sc-hypercare',
    prompt: 'Go-live has happened. In SAP Activate, which phase covers hypercare and the move to steady-state support?',
    options: ['Deploy', 'Realize', 'Run', 'Explore'],
    answer: 2,
    explain: 'Deploy ends with the cutover and go-live. Run is where the system is operated and improved — hypercare and the hand-over to support happen there.'
  }
]);

/** ABAP output: a snippet and what it writes. */
const CODE_QUIZ = Object.freeze([
  {
    id: 'cq-div',
    code: ['DATA lv TYPE i VALUE 7.', 'lv = lv DIV 2.', 'WRITE lv.'],
    prompt: 'What is written?',
    options: ['3', '3.5', '4', '1'],
    answer: 0,
    explain: 'DIV is integer division: it returns the whole-number part of 7 / 2, which is 3. The remainder would come from MOD.'
  },
  {
    id: 'cq-mod',
    code: ['DATA(lv) = 7 MOD 3.', 'WRITE lv.'],
    prompt: 'What is written?',
    options: ['2', '1', '0', '2.33'],
    answer: 1,
    explain: 'MOD returns the remainder of the division: 7 = 2 × 3 + 1.'
  },
  {
    id: 'cq-slash-rounding',
    code: ['DATA(lv) = 5 / 2.', 'WRITE lv.'],
    prompt: 'lv is inferred as type i. What is written?',
    options: ['2', '2.5', '3', 'A runtime error'],
    answer: 2,
    explain: 'With integer operands the result is type i, and ABAP rounds commercially when it assigns 2.5 to an integer: 3. That surprises people coming from languages that truncate.'
  },
  {
    id: 'cq-strlen',
    code: ["DATA(n) = strlen( 'ABAP  ' ).", 'WRITE n.'],
    prompt: 'What is written?',
    options: ['6', '4', '5', '0'],
    answer: 1,
    explain: "A literal in single quotes is a text field (type c), and trailing blanks in a text field do not count — strlen gives 4. In backquotes (a string) the blanks would count and it would be 6."
  },
  {
    id: 'cq-template',
    code: ["DATA(s) = |{ 'SAP' }-{ 4 }|.", 'WRITE s.'],
    prompt: 'What is written?',
    options: ["{ 'SAP' }-{ 4 }", 'SAP4', 'SAP-4', 'SAP - 4'],
    answer: 2,
    explain: 'A string template between | characters evaluates each embedded expression in braces and joins it with the literal text around it.'
  },
  {
    id: 'cq-read-index',
    code: [
      'DATA(lt) = VALUE string_table( ( `a` ) ( `b` ) ( `c` ) ).',
      'READ TABLE lt INTO DATA(lv) INDEX 5.',
      'WRITE sy-subrc.'
    ],
    prompt: 'What is written?',
    options: ['0', '4', '8', '5'],
    answer: 1,
    explain: 'There is no fifth line, so READ TABLE finds nothing and sets sy-subrc to 4. Always test sy-subrc right after the statement that set it.'
  },
  {
    id: 'cq-lines',
    code: ['DATA(lt) = VALUE string_table( ( `x` ) ( `y` ) ( `z` ) ).', 'WRITE lines( lt ).'],
    prompt: 'What is written?',
    options: ['2', '3', '0', '1'],
    answer: 1,
    explain: 'lines( ) returns the number of rows in an internal table: three were added with VALUE.'
  },
  {
    id: 'cq-concatenate',
    code: [
      'DATA lv TYPE string.',
      "CONCATENATE 'SAP' 'HUB' INTO lv SEPARATED BY space.",
      'WRITE lv.'
    ],
    prompt: 'What is written?',
    options: ['SAPHUB', 'SAP HUB', 'SAP space HUB', 'SAP,HUB'],
    answer: 1,
    explain: 'SEPARATED BY space puts one blank between the parts. Without it the result would be SAPHUB.'
  },
  {
    id: 'cq-truncate',
    code: ['DATA lv TYPE c LENGTH 3.', "lv = 'ABCDE'.", 'WRITE lv.'],
    prompt: 'What is written?',
    options: ['ABCDE', 'CDE', 'ABC', 'A runtime error'],
    answer: 2,
    explain: 'Assigning a longer text to a type c field cuts it on the right to the field length — silently, which is why field lengths matter in interfaces.'
  },
  {
    id: 'cq-cond',
    code: ["DATA(lv) = COND string( WHEN 3 > 5 THEN `A` ELSE `B` ).", 'WRITE lv.'],
    prompt: 'What is written?',
    options: ['A', 'B', 'AB', 'Nothing'],
    answer: 1,
    explain: 'COND evaluates its WHEN conditions in order and returns the first that is true, or the ELSE value. 3 > 5 is false, so B.'
  },
  {
    id: 'cq-condense',
    code: ['DATA(lv) = condense( `   SAP    Hub ` ).', 'WRITE lv.'],
    prompt: 'What is written?',
    options: ['SAPHub', 'SAP Hub', '   SAP    Hub', 'SAP    Hub'],
    answer: 1,
    explain: 'condense( ) removes leading and trailing blanks and reduces every run of blanks inside to a single one.'
  },
  {
    id: 'cq-upper',
    code: ["DATA(lv) = to_upper( `abap` ).", 'WRITE lv.'],
    prompt: 'What is written?',
    options: ['abap', 'Abap', 'ABAP', 'A runtime error'],
    answer: 2,
    explain: 'to_upper( ) returns the text in upper case. to_lower( ) and to_mixed( ) are its siblings.'
  }
]);

/** Bug hunter: one line in each snippet is the defect. `answer` is a 0-based line index. */
const BUGS = Object.freeze([
  {
    id: 'bh-select-in-loop',
    code: [
      'SELECT matnr FROM mara INTO TABLE @DATA(lt_mara) UP TO 1000 ROWS.',
      'LOOP AT lt_mara INTO DATA(ls_mara).',
      '  SELECT SINGLE maktx FROM makt INTO @DATA(lv_text)',
      '    WHERE matnr = @ls_mara-matnr AND spras = @sy-langu.',
      'ENDLOOP.'
    ],
    answer: 2,
    explain: 'A database read inside a loop: one round trip per material. Read all the texts at once — a JOIN, or one SELECT with FOR ALL ENTRIES — before the loop.'
  },
  {
    id: 'bh-binary-unsorted',
    code: [
      'SELECT matnr, werks FROM marc INTO TABLE @DATA(lt_marc).',
      'READ TABLE lt_marc INTO DATA(ls_marc) WITH KEY matnr = lv_matnr BINARY SEARCH.',
      'IF sy-subrc = 0.',
      '  WRITE ls_marc-werks.',
      'ENDIF.'
    ],
    answer: 1,
    explain: 'BINARY SEARCH only works on a table sorted by the search key. Nothing sorts lt_marc, so the read can miss a row that is there. SORT lt_marc BY matnr first, or use a sorted table.'
  },
  {
    id: 'bh-fae-empty',
    code: [
      'SELECT vbeln FROM vbak WHERE kunnr = @lv_kunnr INTO TABLE @DATA(lt_orders).',
      'SELECT vbeln, posnr, matnr FROM vbap',
      '  FOR ALL ENTRIES IN @lt_orders',
      '  WHERE vbeln = @lt_orders-vbeln',
      '  INTO TABLE @DATA(lt_items).'
    ],
    answer: 2,
    explain: 'If lt_orders is empty, FOR ALL ENTRIES ignores the WHERE condition and reads every row of VBAP. Check IF lt_orders IS NOT INITIAL before the second SELECT.'
  },
  {
    id: 'bh-bapi-commit',
    code: [
      "CALL FUNCTION 'BAPI_PO_CREATE1'",
      '  EXPORTING poheader = ls_header poheaderx = ls_headerx',
      '  TABLES return = lt_return poitem = lt_item poitemx = lt_itemx.',
      "IF NOT line_exists( lt_return[ type = 'E' ] ).",
      "  WRITE 'Purchase order created'.",
      'ENDIF.'
    ],
    answer: 4,
    explain: "The program reports success but never calls BAPI_TRANSACTION_COMMIT, so the purchase order is not saved. The commit belongs where line 5 claims the work is done."
  },
  {
    id: 'bh-wrong-subrc',
    code: [
      'SELECT SINGLE name1 FROM kna1 WHERE kunnr = @lv_kunnr INTO @DATA(lv_name).',
      'READ TABLE lt_seen WITH KEY table_line = lv_kunnr TRANSPORTING NO FIELDS.',
      'IF sy-subrc <> 0.',
      "  MESSAGE |Customer { lv_kunnr } not found| TYPE 'E'.",
      'ENDIF.'
    ],
    answer: 2,
    explain: 'sy-subrc here belongs to the READ TABLE on line 2, not to the SELECT on line 1. Test the result of a statement immediately after it.'
  },
  {
    id: 'bh-adjacent-unsorted',
    code: [
      'SELECT kunnr FROM vbak WHERE erdat = @sy-datum INTO TABLE @DATA(lt_cust).',
      'DELETE ADJACENT DUPLICATES FROM lt_cust COMPARING kunnr.',
      'DATA(lv_customers) = lines( lt_cust ).',
      'WRITE lv_customers.'
    ],
    answer: 1,
    explain: 'DELETE ADJACENT DUPLICATES only removes duplicates that sit next to each other. Without SORT lt_cust BY kunnr first, the count still includes repeats.'
  },
  {
    id: 'bh-zero-divide',
    code: [
      'DATA(lv_qty) = REDUCE i( INIT s = 0 FOR wa IN lt_items NEXT s = s + wa-menge ).',
      'DATA(lv_avg) = lv_value / lv_qty.',
      'WRITE lv_avg.'
    ],
    answer: 1,
    explain: 'When lt_items is empty, lv_qty is 0 and the division raises CX_SY_ZERODIVIDE. Check for zero before dividing.'
  }
]);

/** Word search: letters only, at most 10, so every word fits a 12 × 12 grid. */
const WORDS = Object.freeze([
  { id: 'ws-fiori', word: 'FIORI', clue: "SAP's design system and the apps built on it" },
  { id: 'ws-hana', word: 'HANA', clue: "SAP's in-memory database" },
  { id: 'ws-abap', word: 'ABAP', clue: "SAP's own programming language" },
  { id: 'ws-idoc', word: 'IDOC', clue: 'The intermediate document format used for EDI and ALE' },
  { id: 'ws-bapi', word: 'BAPI', clue: 'A released business API, called as a function module' },
  { id: 'ws-cutover', word: 'CUTOVER', clue: 'The planned switch from the old system to the new one' },
  { id: 'ws-activate', word: 'ACTIVATE', clue: "SAP's implementation methodology" },
  { id: 'ws-transport', word: 'TRANSPORT', clue: 'Carries changes from development to quality to production' },
  { id: 'ws-client', word: 'CLIENT', clue: 'A self-contained unit inside one SAP system, numbered with three digits' },
  { id: 'ws-plant', word: 'PLANT', clue: 'Where goods are produced or stored, in logistics' },
  { id: 'ws-ariba', word: 'ARIBA', clue: "SAP's procurement network and source-to-pay suite" },
  { id: 'ws-concur', word: 'CONCUR', clue: "SAP's travel and expense product" },
  { id: 'ws-joule', word: 'JOULE', clue: "SAP's AI copilot" },
  { id: 'ws-basis', word: 'BASIS', clue: 'The technical administration of SAP systems' },
  { id: 'ws-variant', word: 'VARIANT', clue: 'A saved set of selection-screen values' },
  { id: 'ws-routing', word: 'ROUTING', clue: 'The sequence of operations to produce a material' },
  { id: 'ws-ledger', word: 'LEDGER', clue: 'In S/4HANA the leading one is usually 0L' },
  { id: 'ws-dump', word: 'DUMP', clue: 'A short one is analysed in ST22' },
  { id: 'ws-signavio', word: 'SIGNAVIO', clue: "SAP's process mining and modelling suite" },
  { id: 'ws-cockpit', word: 'COCKPIT', clue: 'The Migration ___ loads data into a new S/4HANA system' }
]);

/** Typing practice: plain prose about SAP, written for this site. */
const PASSAGES = Object.freeze([
  {
    id: 'tp-activate',
    text: 'SAP Activate runs in six phases: Discover, Prepare, Explore, Realize, Deploy and Run. Explore is where fit-to-standard workshops agree what the standard process covers and what is left as a backlog.'
  },
  {
    id: 'tp-universal-journal',
    text: 'In S/4HANA the Universal Journal keeps financial and controlling line items in one table, ACDOCA. Reports read one source instead of reconciling several, which is why period close becomes faster.'
  },
  {
    id: 'tp-clean-core',
    text: 'A clean core keeps custom code out of the standard. Extensions are built with key-user tools or side by side on SAP BTP, so an upgrade does not have to be retested line by line.'
  },
  {
    id: 'tp-p2p',
    text: 'Procure to pay starts with a requisition, becomes a purchase order, is received with a goods receipt, is matched against the supplier invoice, and ends when the payment run clears the open item.'
  },
  {
    id: 'tp-o2c',
    text: 'Order to cash runs from the sales order through delivery, picking and goods issue to the billing document. The invoice posts a receivable in finance, and the incoming payment clears it.'
  },
  {
    id: 'tp-transport',
    text: 'Changes are made in development, released in a transport request, imported into quality for testing and only then into production. Importing out of order is how a syntax error reaches a test system.'
  }
]);

/* ------------------------------------------------------------------ dates and seeds */

function seedFor(dateIso, salt) {
  return crypto.createHash('sha256').update(`${dateIso}|games|${salt}`).digest();
}

/** A deterministic PRNG from a digest, re-hashed when it runs out so long draws stay varied. */
function rngFrom(digest) {
  let block = digest;
  let i = 0;
  return () => {
    if (i + 4 > block.length) {
      block = crypto.createHash('sha256').update(block).digest();
      i = 0;
    }
    const value = block.readUInt32BE(i);
    i += 4;
    return value / 0x100000000;
  };
}

function shuffled(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function activeOn(bank, dateIso) {
  return bank.filter((item) => (!item.since || item.since <= dateIso) && (!item.retired || dateIso < item.retired));
}

function serverDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function gameOf(key) {
  return GAMES.find((g) => g.key === key) || null;
}

/** Multiple-choice sets share one shape: options shuffled per item, answer re-pointed. */
function mcqSet(bank, gameKey, dateIso, size) {
  const picked = shuffled(activeOn(bank, dateIso), rngFrom(seedFor(dateIso, `${gameKey}:pick`))).slice(0, size);
  return picked.map((item) => {
    const order = shuffled(
      item.options.map((label, index) => ({ label, index })),
      rngFrom(seedFor(dateIso, `${gameKey}:opts:${item.id}`))
    );
    return {
      id: item.id,
      prompt: item.prompt,
      code: item.code ? item.code.slice() : null,
      explain: item.explain,
      options: order.map((o) => o.label),
      answer: order.findIndex((o) => o.index === item.answer)
    };
  });
}

/* ------------------------------------------------------------------ word search grid */

const GRID_SIZE = 12;
const DIRECTIONS = Object.freeze([[0, 1], [1, 0], [1, 1], [-1, 1]]); // right, down, down-right, up-right
const FILLER = 'ABCDEFGHIJKLMNOPRSTUVW';

/**
 * Place the words into a grid, deterministically from the date. Words read forwards only
 * (four directions), which is enough of a puzzle and keeps it fair on a phone. A word that
 * cannot be placed after many tries is dropped from the day rather than overlapped wrongly;
 * the boot assertion checks that a full set fits on a run of sample days.
 */
function buildGrid(words, random) {
  const grid = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
  const placed = [];
  for (const entry of words) {
    const letters = entry.word;
    let done = false;
    for (let attempt = 0; attempt < 300 && !done; attempt += 1) {
      const [dr, dc] = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
      const r0 = Math.floor(random() * GRID_SIZE);
      const c0 = Math.floor(random() * GRID_SIZE);
      const rEnd = r0 + dr * (letters.length - 1);
      const cEnd = c0 + dc * (letters.length - 1);
      if (rEnd < 0 || rEnd >= GRID_SIZE || cEnd < 0 || cEnd >= GRID_SIZE) continue;
      let fits = true;
      for (let k = 0; k < letters.length && fits; k += 1) {
        const cell = grid[r0 + dr * k][c0 + dc * k];
        if (cell !== null && cell !== letters[k]) fits = false;
      }
      if (!fits) continue;
      for (let k = 0; k < letters.length; k += 1) grid[r0 + dr * k][c0 + dc * k] = letters[k];
      placed.push(entry);
      done = true;
    }
  }
  for (let r = 0; r < GRID_SIZE; r += 1) {
    for (let c = 0; c < GRID_SIZE; c += 1) {
      if (grid[r][c] === null) grid[r][c] = FILLER[Math.floor(random() * FILLER.length)];
    }
  }
  return { grid: grid.map((row) => row.join('')), placed };
}

/** Letters only, upper case: "s/4 Hana" and "HANA " are both HANA, nothing else is. */
function normaliseWord(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z]/g, '') : '';
}

/* ------------------------------------------------------------------ the daily set */

/**
 * The full set for a game on a date, ANSWERS INCLUDED. Only `publicFormOf` may reach a
 * template before an attempt is closed.
 */
function dailySetFor(gameKey, dateIso) {
  const game = gameOf(gameKey);
  if (!game) throw new Error(`unknown game: ${gameKey}`);
  const random = rngFrom(seedFor(dateIso, `${gameKey}:pick`));

  switch (gameKey) {
    case 'match': {
      const pairs = shuffled(activeOn(CODES, dateIso), random).slice(0, game.perDay);
      const meanings = shuffled(pairs.map((p) => p.meaning), rngFrom(seedFor(dateIso, 'match:meanings')));
      return {
        meanings,
        items: pairs.map((p) => ({ id: p.id, term: p.term, kind: p.kind, meaning: p.meaning, answer: meanings.indexOf(p.meaning) }))
      };
    }
    case 'scenario':
      return { items: mcqSet(SCENARIOS, gameKey, dateIso, game.perDay) };
    case 'codequiz':
      return { items: mcqSet(CODE_QUIZ, gameKey, dateIso, game.perDay) };
    case 'bughunter': {
      const picked = shuffled(activeOn(BUGS, dateIso), random).slice(0, game.perDay);
      return { items: picked.map((b) => ({ id: b.id, code: b.code.slice(), answer: b.answer, explain: b.explain })) };
    }
    case 'wordsearch': {
      const picked = shuffled(activeOn(WORDS, dateIso), random).slice(0, game.perDay);
      // Longest first places most reliably.
      const ordered = picked.slice().sort((a, b) => b.word.length - a.word.length);
      const { grid, placed } = buildGrid(ordered, rngFrom(seedFor(dateIso, 'wordsearch:grid')));
      const placedIds = new Set(placed.map((p) => p.id));
      return {
        grid,
        items: picked.filter((w) => placedIds.has(w.id)).map((w) => ({ id: w.id, clue: w.clue, letters: w.word.length, word: w.word }))
      };
    }
    case 'flashcards':
      return { items: shuffled(activeOn(CODES, dateIso), random).slice(0, game.perDay).map((c) => ({ ...c })) };
    case 'typing': {
      const passages = activeOn(PASSAGES, dateIso);
      return { items: [{ ...passages[Math.floor(random() * passages.length)] }] };
    }
    default:
      throw new Error(`no set builder for ${gameKey}`);
  }
}

/**
 * What a browser may see before grading. The answer, the correct meaning, the word and the
 * explanation are all removed — an explanation names the right option in prose. Practice
 * games are returned whole: there is nothing to grade, so there is nothing to give away.
 */
function publicFormOf(gameKey, set) {
  const game = gameOf(gameKey);
  if (!game.scored) return set;
  switch (gameKey) {
    case 'match':
      return { meanings: set.meanings.slice(), items: set.items.map((i) => ({ id: i.id, term: i.term, kind: i.kind })) };
    case 'scenario':
    case 'codequiz':
      return { items: set.items.map((i) => ({ id: i.id, prompt: i.prompt, code: i.code, options: i.options.slice() })) };
    case 'bughunter':
      return { items: set.items.map((i) => ({ id: i.id, code: i.code.slice() })) };
    case 'wordsearch':
      return { grid: set.grid.slice(), items: set.items.map((i) => ({ id: i.id, clue: i.clue, letters: i.letters })) };
    default:
      throw new Error(`no public form for ${gameKey}`);
  }
}

/** An index from a body: an integer, or a string of digits only — never `parseInt`. */
function indexFrom(raw, length) {
  const n = Number.isInteger(raw) ? raw : /^\d+$/.test(String(raw ?? '')) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n < length ? n : null;
}

/**
 * Grade a submission against the set. Pure. `submitted` is keyed by item id (the form posts
 * `answers[<id>]`, for the reason gradeAnswers in config/challenges.js gives), and anything
 * unreadable counts as unanswered rather than throwing.
 */
function grade(gameKey, set, submitted) {
  const given = submitted && typeof submitted === 'object' ? submitted : {};
  const pick = (id) => (Object.prototype.hasOwnProperty.call(given, id) ? given[id] : undefined);

  let results;
  switch (gameKey) {
    case 'match':
      results = set.items.map((i) => {
        const chosen = indexFrom(pick(i.id), set.meanings.length);
        return {
          id: i.id, term: i.term, kind: i.kind,
          chosen: chosen === null ? null : set.meanings[chosen],
          answer: i.meaning,
          correct: chosen === i.answer
        };
      });
      break;
    case 'scenario':
    case 'codequiz':
      results = set.items.map((i) => {
        const chosen = indexFrom(pick(i.id), i.options.length);
        return {
          id: i.id, prompt: i.prompt, code: i.code, options: i.options.slice(),
          chosen, answer: i.answer, correct: chosen === i.answer, explain: i.explain
        };
      });
      break;
    case 'bughunter':
      results = set.items.map((i) => {
        const chosen = indexFrom(pick(i.id), i.code.length);
        return { id: i.id, code: i.code.slice(), chosen, answer: i.answer, correct: chosen === i.answer, explain: i.explain };
      });
      break;
    case 'wordsearch':
      results = set.items.map((i) => {
        const typed = normaliseWord(pick(i.id));
        return { id: i.id, clue: i.clue, chosen: typed || null, answer: i.word, correct: typed === i.word };
      });
      break;
    default:
      throw new Error(`${gameKey} is not graded`);
  }

  const score = results.filter((r) => r.correct).length;
  const total = results.length;
  return { results, score, total, points: pointsFor(score, total) };
}

/** What is stored for an attempt: the choice per id, so a day can be regraded exactly. */
function recordOf(graded) {
  return graded.results.map((r) => ({ id: r.id, chosen: r.chosen, correct: r.correct }));
}

/**
 * Rebuild a submission from a stored record. Match stores the chosen MEANING (stable
 * across a regrade) rather than an index, so it is mapped back to today's position.
 */
function submissionFromRecord(gameKey, set, record) {
  const out = {};
  for (const entry of Array.isArray(record) ? record : []) {
    if (!entry || entry.id === undefined || entry.chosen === null || entry.chosen === undefined) continue;
    out[entry.id] = gameKey === 'match' ? set.meanings.indexOf(entry.chosen) : entry.chosen;
  }
  return out;
}

/* ------------------------------------------------------------------ boot assertion */

function assertGamesIntegrity() {
  const keys = new Set();
  for (const game of GAMES) {
    if (!/^[a-z]+$/.test(game.key) || keys.has(game.key)) throw new Error(`bad or duplicate game key: ${game.key}`);
    keys.add(game.key);
    if (!game.title || !game.blurb || !game.icon) throw new Error(`game ${game.key} is missing its title, blurb or icon`);
    if (!Number.isInteger(game.perDay) || game.perDay < 1) throw new Error(`game ${game.key} needs a positive perDay`);
  }

  const ids = new Set();
  const checkId = (id) => {
    if (!id || ids.has(id)) throw new Error(`duplicate or missing item id: ${id}`);
    ids.add(id);
  };
  const checkMcq = (item) => {
    checkId(item.id);
    if (!item.prompt || !item.explain) throw new Error(`${item.id} is missing its prompt or explanation`);
    if (!Array.isArray(item.options) || item.options.length < 2 || new Set(item.options).size !== item.options.length) {
      throw new Error(`${item.id} needs at least two distinct options`);
    }
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer >= item.options.length) {
      throw new Error(`${item.id} has an answer outside its options`);
    }
  };

  const terms = new Set();
  const meanings = new Set();
  for (const c of CODES) {
    checkId(c.id);
    // Two identical meanings would make a match set with two right answers for one slot.
    if (terms.has(c.term) || meanings.has(c.meaning)) throw new Error(`code ${c.id} repeats a term or a meaning`);
    terms.add(c.term);
    meanings.add(c.meaning);
  }
  SCENARIOS.forEach(checkMcq);
  CODE_QUIZ.forEach((item) => {
    checkMcq(item);
    if (!Array.isArray(item.code) || !item.code.length) throw new Error(`${item.id} has no code`);
  });
  for (const b of BUGS) {
    checkId(b.id);
    if (!Array.isArray(b.code) || b.code.length < 2) throw new Error(`${b.id} needs at least two lines`);
    if (!Number.isInteger(b.answer) || b.answer < 0 || b.answer >= b.code.length) throw new Error(`${b.id} points at a line it does not have`);
    if (!b.explain) throw new Error(`${b.id} has no explanation`);
  }
  for (const w of WORDS) {
    checkId(w.id);
    if (!/^[A-Z]{3,10}$/.test(w.word)) throw new Error(`word ${w.id} must be 3-10 capital letters to fit the grid`);
    if (!w.clue || w.clue.toUpperCase().includes(w.word)) throw new Error(`word ${w.id} has no clue, or a clue that gives the word away`);
  }
  for (const p of PASSAGES) {
    checkId(p.id);
    if (!p.text || p.text.length < 80) throw new Error(`passage ${p.id} is too short to practise on`);
  }

  const today = serverDate();
  const sizes = { match: CODES, scenario: SCENARIOS, codequiz: CODE_QUIZ, bughunter: BUGS, wordsearch: WORDS, flashcards: CODES };
  for (const [key, bank] of Object.entries(sizes)) {
    if (activeOn(bank, today).length < gameOf(key).perDay * 2) {
      throw new Error(`the ${key} bank is too small: every day would be nearly the same set`);
    }
  }
  // A grid that cannot place its six words on some day is a puzzle with a missing answer.
  for (let d = 0; d < 60; d += 1) {
    const date = serverDate(new Date(Date.UTC(2026, 9, 1) + d * 86_400_000));
    const set = dailySetFor('wordsearch', date);
    if (set.items.length !== gameOf('wordsearch').perDay) throw new Error(`word search for ${date} placed only ${set.items.length} words`);
  }
  return true;
}

module.exports = {
  GAMES,
  SCORED_KEYS,
  GRID_SIZE,
  gameOf,
  pointsFor,
  serverDate,
  dailySetFor,
  publicFormOf,
  grade,
  recordOf,
  submissionFromRecord,
  normaliseWord,
  assertGamesIntegrity,
  // Exposed for the tests that check the content itself.
  banks: { CODES, SCENARIOS, CODE_QUIZ, BUGS, WORDS, PASSAGES }
};
