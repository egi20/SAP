'use strict';

/**
 * Drafting a cold outreach message.
 *
 * Three things are worth asserting without a model in the loop: what leaves this process,
 * what the prompt is built from, and what the verifier refuses. The last one is the whole
 * safety argument — a draft is a sentence somebody sends to a stranger under their own
 * name, so the checks run before anybody reads it.
 */

const fs = require('fs');
const path = require('path');
const outreach = require('../../utils/outreachDrafting');
const drafting = require('../../config/drafting');
const { PRODUCT_LINES } = require('../../config/sapProducts');

const root = path.join(__dirname, '..', '..');

const lead = (over = {}) => ({
  id: 1,
  company: 'Nordwind GmbH',
  contact_name: 'Petra Klein',
  contact_email: 'petra.klein@nordwind.example',
  contact_phone: '+49 30 123456',
  linkedin_url: 'https://www.linkedin.com/in/petra',
  job_title: 'CIO',
  country: 'DE',
  product_lines: [],
  ...over
});

/** 45 words of harmless prose, which is inside the word bounds and trips nothing else. */
const CLEAN =
  'We run a marketplace where companies hire SAP consultants for contract work, and where a '
  + 'scope estimate can be produced before anybody commits to a programme of work. I am getting '
  + 'in touch because that may be useful to your team. Would it be worth a short conversation '
  + 'about whether it fits?';

describe('what leaves this process', () => {
  it('is the company, the job title, the country and nothing personal', () => {
    const facts = outreach.factsFor(lead());
    expect(facts).toContain('Nordwind GmbH');
    expect(facts).toContain('CIO');
    expect(facts).toContain('DE');

    /*
     * None of this improves a first paragraph about what the Hub does, and all of it would
     * be somebody's contact details leaving for a third party. The name is put back by the
     * sender afterwards, locally, from the row.
     */
    expect(facts).not.toContain('Petra');
    expect(facts).not.toContain('petra.klein@nordwind.example');
    expect(facts).not.toContain('+49 30 123456');
    expect(facts).not.toContain('linkedin');
  });

  it('says plainly when no product area was recorded, rather than leaving it out', () => {
    // An absent line reads as "say what you like"; a present one is an instruction.
    expect(outreach.factsFor(lead())).toMatch(/Do not name one/i);
    expect(outreach.factsFor(lead({ product_lines: ['s4hana-finance'] }))).toContain('SAP S/4HANA Finance');
  });
});

describe('the prompt', () => {
  it('lists the SAP vocabulary from the catalogue rather than typing it', () => {
    // A hand-typed list of SAP products in a prompt is a second catalogue, and the drift
    // is a draft confidently naming a product the rest of the site has never heard of.
    PRODUCT_LINES.forEach((line) => expect(outreach.ROLE).toContain(line.label));

    const source = fs.readFileSync(path.join(root, 'utils', 'outreachDrafting.js'), 'utf8');
    expect(source).toContain('PRODUCT_LINES.map');
  });

  it('is composed once, so the cached prefix actually hits', () => {
    const source = fs.readFileSync(path.join(root, 'utils', 'outreachDrafting.js'), 'utf8');
    // `const ROLE = \`...\`` at module load, not built per call.
    expect(source).toMatch(/^const ROLE = `/m);
    expect(source).toContain("cache_control: { type: 'ephemeral' }");
  });

  it('forbids inventing a relationship, a figure or a product area', () => {
    expect(outreach.ROLE).toMatch(/Invent nothing about the recipient/);
    expect(outreach.ROLE).toMatch(/no numerals/i);
    expect(outreach.ROLE).toMatch(/do not guess at one/i);
  });
});

describe('the verifier', () => {
  it('passes a plain draft', () => {
    expect(outreach.problemsWith(CLEAN, lead())).toEqual([]);
  });

  it('refuses a fabricated familiarity', () => {
    const problems = outreach.problemsWith(`I saw your recent announcement. ${CLEAN}`, lead());
    expect(problems.join(' ')).toMatch(/familiarity/i);
  });

  it('refuses a commitment', () => {
    ['we guarantee a result', 'a fixed price for the work', 'this will save you money'].forEach((phrase) => {
      expect(outreach.problemsWith(`${CLEAN} ${phrase}`, lead()).join(' ')).toMatch(/commitment/i);
    });
  });

  it('refuses any numeral at all', () => {
    // The model was handed none, so any it wrote are invented.
    expect(outreach.problemsWith(`${CLEAN} We have 600 consultants.`, lead()).join(' ')).toMatch(/figures/i);
  });

  it('refuses a placeholder', () => {
    expect(outreach.problemsWith(`${CLEAN} [insert company]`, lead()).join(' ')).toMatch(/placeholder/i);
  });

  it('refuses the word bounds either side', () => {
    expect(outreach.problemsWith('Too short.', lead()).join(' ')).toMatch(/too short/i);
    const long = `${CLEAN} `.repeat(10);
    expect(outreach.problemsWith(long, lead()).join(' ')).toMatch(/too long/i);
  });
});

describe('the SAP rule, which is the one this site adds', () => {
  it('refuses a module code the lead was never recorded against', () => {
    /*
     * Guessing which SAP products a company runs is the most plausible-sounding invention
     * available to the model and the easiest for the reader to catch.
     */
    const problems = outreach.problemsWith(`${CLEAN} Your FI landscape in particular.`, lead());
    expect(problems.join(' ')).toMatch(/module code it was not given: "FI"/);
  });

  it('refuses a product area the lead was never recorded against', () => {
    const problems = outreach.problemsWith(`${CLEAN} Especially SAP S/4HANA Finance.`, lead());
    expect(problems.join(' ')).toMatch(/product area it was not given/i);
  });

  it('allows the product area that WAS recorded', () => {
    const problems = outreach.problemsWith(
      `${CLEAN} Especially SAP S/4HANA Finance.`,
      lead({ product_lines: ['s4hana-finance'] })
    );
    expect(problems).toEqual([]);
  });

  it('does not trip over two-letter words in ordinary prose', () => {
    // `includes('mm')` matches "committed" and `includes('fi')` matches "specific", and
    // every SAP advert contains both. The codes are matched as whole words, in upper case.
    const prose = `${CLEAN} We are committed to specific outcomes and co-operate closely.`;
    expect(outreach.problemsWith(prose, lead()).join(' ')).not.toMatch(/module code/);
  });

  it('does not trip over a module code inside the company\'s own name', () => {
    // An SAP partner called "FI Consulting GmbH" must not fail every check about codes.
    const problems = outreach.problemsWith(`${CLEAN}`, lead({ company: 'FI Consulting GmbH' }));
    expect(problems).toEqual([]);
  });
});

describe('config/drafting.js', () => {
  it('asserts itself, and is asserted at boot', () => {
    expect(() => drafting.assertDraftingIntegrity()).not.toThrow();
    expect(fs.readFileSync(path.join(root, 'server.js'), 'utf8')).toContain('assertDraftingIntegrity()');
  });

  it('refuses a model changed without its prices', () => {
    /*
     * The silent failure this config exists for: the breaker keeps charging the old rate
     * against the new model, and the first anybody hears of it is the invoice.
     */
    const before = { ...process.env };
    jest.resetModules();
    process.env.CRM_DRAFT_MODEL = 'some-other-model';
    delete process.env.CRM_DRAFT_PRICE_INPUT_USD;
    delete process.env.CRM_DRAFT_PRICE_OUTPUT_USD;
    // eslint-disable-next-line global-require
    const reloaded = require('../../config/drafting');
    expect(reloaded.draftingProblems().join(' ')).toMatch(/prices are not/i);
    process.env = before;
    jest.resetModules();
  });

  it('spends from the same ledger as the assistant', () => {
    const source = fs.readFileSync(path.join(root, 'utils', 'outreachDrafting.js'), 'utf8');
    // Two AI features with two budgets is two invoices and no answer to "what did this
    // cost".
    expect(source).toContain("require('./aiBudget')");
    expect(source).toContain('assertWithinBudget');
    expect(source).toContain('chargeToCache');
  });
});

describe('nothing here sends', () => {
  it('has no transport, and no retry loop around the model', () => {
    const source = fs
      .readFileSync(path.join(root, 'utils', 'outreachDrafting.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    ['nodemailer', 'sendMail', 'sendgrid', 'smtp'].forEach((term) => {
      expect(source.toLowerCase()).not.toContain(term.toLowerCase());
    });
    // A rejected draft is returned, not re-requested: an automatic retry hides the failure
    // this feature has to be watched for and pays for every attempt.
    expect(source).not.toMatch(/for\s*\(.*attempt/i);
  });
});
