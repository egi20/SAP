'use strict';

const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

const { HEX, FONT, formatMoney } = require('./brand');
const { assertDocumentOpens } = require('./validate');

/**
 * A CV, rendered from what `utils/cvData.js` assembled.
 *
 * THIS FILE COMPUTES NOTHING, the same rule the statement-of-work renderer follows. Every
 * value here was read off the member's own profile; a formatter that re-derived a date
 * range or a seniority would be a second opinion about somebody's career.
 *
 * ATS-FRIENDLY IS A SHAPE, NOT A CLAIM. The reference advertises it on a landing page and
 * then lays its CV out in a two-column table. An applicant-tracking system reads the
 * document in linear order, and a table, a text box or a page header is where the parsing
 * goes wrong: columns interleave, boxes are skipped, and a header repeats on every page as
 * though it were content. So this document is a single column of headings, paragraphs and
 * bullets, with no table anywhere in it and nothing in a header or a footer that a reader
 * needs. It is less decorative than it could be, on purpose.
 */

const HEADING_SPACING = { before: 280, after: 120 };

function text(value, options = {}) {
  return new TextRun({ text: String(value ?? ''), font: FONT, ...options });
}

function para(value, options = {}) {
  const { spacing, alignment, ...runOptions } = options;
  return new Paragraph({
    alignment,
    spacing: spacing || { after: 100 },
    children: [text(value, runOptions)]
  });
}

function heading(value) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: HEADING_SPACING,
    children: [text(value, { bold: true, size: 24, color: HEX.accent || HEX.ink })]
  });
}

function bullet(value) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60 },
    children: [text(value, { size: 20 })]
  });
}

/** The one-line facts under the name, joined only where they exist. */
function factsLine(cv) {
  const facts = [];
  if (cv.role) facts.push(cv.role);
  if (cv.seniority) facts.push(cv.seniority);
  if (cv.yearsExperience !== null) facts.push(`${cv.yearsExperience} years`);
  // Zero is printed. It is a real answer, and the people giving it are the honest ones.
  if (cv.fullLifecycles !== null) {
    facts.push(`${cv.fullLifecycles} full lifecycle${cv.fullLifecycles === 1 ? '' : 's'}`);
  }
  if (cv.location) facts.push(cv.location);
  if (cv.workMode) facts.push(cv.workMode);
  return facts.join('  ·  ');
}

function engagementParagraphs(cv) {
  const out = [];
  cv.engagements.forEach((e) => {
    const title = [e.name, e.client].filter(Boolean).join(' — ');
    out.push(new Paragraph({
      spacing: { before: 160, after: 40 },
      children: [text(title, { bold: true, size: 21 })]
    }));

    const meta = [e.role, e.phase, e.period].filter(Boolean).join('  ·  ');
    if (meta) out.push(para(meta, { size: 18, color: HEX.muted || HEX.ink, spacing: { after: 40 } }));

    const marks = [];
    if (e.isFullLifecycle) marks.push('Full lifecycle');
    if (e.matchedModules.length) marks.push(`Relevant here: ${e.matchedModules.join(', ')}`);
    if (marks.length) out.push(para(marks.join('  ·  '), { size: 18, italics: true, spacing: { after: 40 } }));

    if (e.modules.length) {
      out.push(para(`Modules: ${e.modules.map((m) => m.label).join(', ')}`, { size: 18, spacing: { after: 40 } }));
    }
    if (e.description) out.push(para(e.description, { size: 20 }));
  });
  return out;
}

/**
 * @returns {Promise<Buffer>} a .docx that has been opened and parsed before it is returned.
 */
async function buildCvDocx(cv) {
  const children = [];

  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    spacing: { after: 60 },
    children: [text(cv.name || 'Consultant', { bold: true, size: 36 })]
  }));

  if (cv.headline) children.push(para(cv.headline, { size: 22, color: HEX.muted || HEX.ink }));

  const facts = factsLine(cv);
  if (facts) children.push(para(facts, { size: 19, color: HEX.muted || HEX.ink }));

  if (cv.contact) {
    const lines = [cv.contact.email, cv.contact.linkedin].filter(Boolean);
    if (lines.length) children.push(para(lines.join('  ·  '), { size: 19 }));
  }
  if (cv.rate) {
    children.push(para(`Indicative day rate: ${formatMoney(cv.rate.amount, cv.rate.currency)}`, { size: 19 }));
  }

  /*
   * Stated on the document, not only on the page that produced it. A CV is forwarded, and
   * the reader three hops along has no idea which advert it was ordered against — without
   * this line, "Relevant here" below is a claim with no subject.
   */
  if (cv.targetedAt) {
    children.push(para(
      `Prepared for: ${[cv.targetedAt.title, cv.targetedAt.company].filter(Boolean).join(' — ')}`,
      { size: 18, italics: true }
    ));
  }

  if (cv.about) {
    children.push(heading('Summary'));
    children.push(para(cv.about, { size: 20 }));
  }

  if (cv.engagements.length) {
    children.push(heading('Delivery history'));
    engagementParagraphs(cv).forEach((p) => children.push(p));
  }

  if (cv.experiences.length) {
    children.push(heading('Employment'));
    cv.experiences.forEach((e) => {
      children.push(new Paragraph({
        spacing: { before: 140, after: 40 },
        children: [text([e.title, e.company].filter(Boolean).join(' — '), { bold: true, size: 21 })]
      }));
      if (e.period) children.push(para(e.period, { size: 18, color: HEX.muted || HEX.ink, spacing: { after: 40 } }));
      if (e.description) children.push(para(e.description, { size: 20 }));
    });
  }

  if (cv.certifications.length) {
    children.push(heading('Certifications'));
    cv.certifications.forEach((c) => {
      children.push(bullet(c.earned ? `${c.label} (${c.earned})` : c.label));
    });
  }

  if (cv.skills.length) {
    children.push(heading('Skills'));
    children.push(para(cv.skills.join(', '), { size: 20 }));
  }

  children.push(new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 320 },
    children: [text(
      `Generated from a SAP Hub profile on ${cv.generatedAt.toISOString().slice(0, 10)}.`,
      { size: 16, color: HEX.muted || HEX.ink }
    )]
  }));

  const doc = new Document({
    creator: cv.name || 'SAP Hub',
    title: cv.name ? `${cv.name} — CV` : 'CV',
    description: 'Curriculum vitae',
    sections: [{ children }]
  });

  const buffer = await Packer.toBuffer(doc);
  // Never serve a document nobody has opened: a subtly broken part downloads fine and then
  // refuses to open, which the recipient experiences as "you sent me a corrupt file".
  assertDocumentOpens(buffer, 'docx', 'CV');
  return buffer;
}

module.exports = { buildCvDocx };
