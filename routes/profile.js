'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const User = require('../models/User');
const ConsultantProfile = require('../models/ConsultantProfile');
const ExternalIdentity = require('../models/ExternalIdentity');
const linkedinConfig = require('../config/linkedin');
const CompanyProfile = require('../models/CompanyProfile');
const ImageBlob = require('../models/ImageBlob');
const Skill = require('../models/Skill');
const { isAuthenticated, isConsultant, isCompany } = require('../middleware/auth');
const { writeLimiter, passwordLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { singleImage } = require('../middleware/fileUpload');
const { requireIdParam } = require('../utils/ids');
const { sanitizeRichText } = require('../utils/sanitize');
const { slugify } = require('../utils/slug');
const Job = require('../models/Job');
const AccountClosure = require('../models/AccountClosure');
const { buildCv, cvGaps } = require('../utils/cvData');
const { buildCvDocx } = require('../utils/documents/cvDocx');
const { ROLE_CATEGORIES, ROLE_SLUGS } = require('../config/roleTaxonomy');
const { CERTIFICATIONS, OTHER_CODE, isCertificationCode } = require('../config/certifications');
const { PRODUCT_LINES, ALL_MODULES, isModule } = require('../config/sapProducts');
const countries = require('../config/all-countries.json');

const router = express.Router();

router.use(isAuthenticated);

/**
 * The account overview.
 *
 * This URL used to redirect to `/profile/settings`, which answered the question "what can
 * I change about my account" to somebody who asked "what IS my account". They are
 * different questions: the facts a person comes here to check — which email address this
 * is, which roles the account holds, whether the address is confirmed, when they joined,
 * when they were last in — are on no form, because none of them is editable from one.
 *
 * It computes nothing and stores nothing. Every panel is a link to the page that owns the
 * thing it names, so there is no second place that decides what a profile says.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const user = await User.findById(sessionUser.id);
    if (!user) return res.status(404).render('errors/404', { title: 'Not found' });

    // Only what this account actually has. A consultant has no company page and a company
    // has no CV, and offering either is offering a 404 with an encouraging label on it.
    const [consultantProfile, companyProfile] = await Promise.all([
      user.is_consultant ? ConsultantProfile.findByUserId(user.id) : Promise.resolve(null),
      user.is_company ? CompanyProfile.findByUserId(user.id) : Promise.resolve(null)
    ]);

    return res.render('profile/index', {
      title: 'Your account',
      user,
      consultantProfile,
      companyProfile
    });
  })
);

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.session.user.id);
    res.render('profile/settings', {
      title: 'Account settings',
      user,
      // The identity row, not the mirrored flag: the panel shows WHAT was confirmed —
      // the name and the date — and a boolean cannot say either.
      linkedInIdentity: await ExternalIdentity.find(ExternalIdentity.LINKEDIN, req.session.user.id),
      linkedInEnabled: linkedinConfig.isConfigured(),
      errors: []
    });
  })
);

/**
 * Self-service role changes are ADD-ONLY and limited to the public roles.
 *
 * The model does the union; this route never computes a role set of its own. A form post
 * therefore cannot remove a role, cannot demote an admin, and cannot grant a privileged
 * role however it is crafted.
 */
router.post(
  '/settings/roles',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const submitted = Array.isArray(req.body.roles) ? req.body.roles : [req.body.roles].filter(Boolean);
    const roles = await User.addSelfServiceRoles(req.session.user.id, submitted);

    if (roles.includes('consultant')) await ConsultantProfile.ensureExists(req.session.user.id);
    if (roles.includes('company')) await CompanyProfile.ensureExists(req.session.user.id, req.session.user.name);

    req.flash('success', 'Roles updated. Removing a role is done by support.');
    return res.redirect('/profile/settings');
  })
);

router.post(
  '/settings/password',
  passwordLimiter,
  [
    body('current_password').notEmpty(),
    body('password')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/)
      .withMessage('Your new password needs at least 8 characters, including an uppercase letter, a lowercase letter and a number.'),
    body('confirm_password').custom((v, { req }) => v === req.body.password).withMessage('The two passwords do not match.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/profile/settings');
    }

    const user = await User.findById(req.session.user.id);
    if (!(await User.verifyPassword(user, req.body.current_password))) {
      req.flash('error', 'Your current password is not correct.');
      return res.redirect('/profile/settings');
    }

    await User.updatePassword(user.id, req.body.password);
    req.flash('success', 'Password updated.');
    return res.redirect('/profile/settings');
  })
);

/**
 * THE CV, built from the profile and nothing else.
 *
 * There is no wizard. The reference asks people to type their career into a form, which
 * produces a second copy of a CV that starts drifting from the profile the directory
 * searches the moment either is edited. Everything a CV needs is already on the profile —
 * including the delivery history, which is the part a generic CV builder cannot ask for
 * because it does not know what a module is.
 *
 * Both routes are consultant-only and read THIS member's own rows. There is no id in the
 * path: a CV endpoint that takes one is a CV endpoint somebody will enumerate.
 */
async function cvFor(userId, jobSlug, options) {
  const profile = await ConsultantProfile.findByUserId(userId);
  if (!profile) return null;

  const [skills, certifications, experiences, projects] = await Promise.all([
    Skill.forConsultant(userId),
    ConsultantProfile.listCertifications(userId),
    ConsultantProfile.listExperiences(userId),
    ConsultantProfile.listProjects(userId)
  ]);

  /*
   * The advert is loaded only to ORDER the engagements, and only when it is one anybody
   * could read: `Job.findBySlug` plus the open check, so a draft cannot be probed through
   * the CV builder by somebody guessing slugs.
   */
  let job = null;
  if (jobSlug) {
    const found = await Job.findBySlug(jobSlug);
    if (found && found.status === 'open') {
      job = { ...found, modules: await Job.modulesFor(found.id) };
    }
  }

  return buildCv({ profile, skills, certifications, experiences, projects, job }, options);
}

function cvOptionsFrom(query) {
  return {
    // Both off unless asked for, every time. A CV travels further than the person who
    // wrote it expects, and a day rate on a document that reaches a procurement team is a
    // negotiating position given away before the conversation starts.
    includeRate: query.rate === '1',
    includeContact: query.contact === '1'
  };
}

router.get(
  '/cv',
  isConsultant,
  asyncHandler(async (req, res) => {
    const options = cvOptionsFrom(req.query);
    const jobSlug = req.query.job ? String(req.query.job).slice(0, 220) : '';
    const cv = await cvFor(req.session.user.id, jobSlug, options);
    if (!cv) return res.redirect('/profile/consultant');

    return res.render('profile/cv', {
      title: 'Your CV',
      cv,
      gaps: cvGaps(cv),
      options,
      jobSlug
    });
  })
);

router.get(
  '/cv.docx',
  isConsultant,
  asyncHandler(async (req, res) => {
    const options = cvOptionsFrom(req.query);
    const jobSlug = req.query.job ? String(req.query.job).slice(0, 220) : '';
    const cv = await cvFor(req.session.user.id, jobSlug, options);
    if (!cv) return res.redirect('/profile/consultant');

    const buffer = await buildCvDocx(cv);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // Slugified, so a name with a quote, a slash or a newline in it cannot reach the header.
    res.setHeader('Content-Disposition', `attachment; filename="${slugify(cv.name || 'cv')}-cv.docx"`);
    res.setHeader('Content-Length', buffer.length);
    // Generated on demand from a profile that can change in the next minute; never cached.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(buffer);
  })
);

router.get(
  '/consultant',
  isConsultant,
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const profile = await ConsultantProfile.ensureExists(userId);
    const [skills, certifications, experiences, projects] = await Promise.all([
      Skill.forConsultant(userId),
      ConsultantProfile.listCertifications(userId),
      ConsultantProfile.listExperiences(userId),
      ConsultantProfile.listProjects(userId)
    ]);

    res.render('profile/consultant', {
      title: 'Your consultant profile',
      profile,
      skills,
      certifications,
      experiences,
      projects,
      allModules: ALL_MODULES,
      productLines: PRODUCT_LINES,
      activatePhases: Job.ACTIVATE_PHASES,
      roleCategories: ROLE_CATEGORIES,
      certificationGroups: CERTIFICATIONS,
      otherCertificationCode: OTHER_CODE,
      countries,
      minCompleteness: ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH,
      errors: []
    });
  })
);

router.post(
  '/consultant',
  isConsultant,
  writeLimiter,
  [
    body('headline').optional({ checkFalsy: true }).isLength({ max: 200 }),
    body('primary_role').optional({ checkFalsy: true }).isIn(ROLE_SLUGS),
    body('day_rate').optional({ checkFalsy: true }).isFloat({ min: 0, max: 100000 }),
    body('years_experience').optional({ checkFalsy: true }).isInt({ min: 0, max: 60 }),
    /*
     * `checkFalsy` is wrong here and that is the whole point of the separate validator:
     * '0' is falsy, and zero full lifecycles is a real, honest answer that has to survive
     * the form. `optional({ values: 'falsy' })` — which is what checkFalsy means — would
     * silently drop it, and the field would appear not to save for exactly the people most
     * likely to be truthful about it.
     */
    body('full_lifecycles').optional({ checkFalsy: false }).isInt({ min: 0, max: 40 })
      .withMessage('Full lifecycles must be a whole number between 0 and 40.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg || 'Please check the form.');
      return res.redirect('/profile/consultant');
    }

    await ConsultantProfile.update(req.session.user.id, {
      headline: req.body.headline || null,
      bio: sanitizeRichText(req.body.bio || ''),
      primary_role: req.body.primary_role || null,
      seniority: req.body.seniority || null,
      years_experience: req.body.years_experience || null,
      // An empty field is "not said" (NULL); a typed 0 is "none", and they are different.
      full_lifecycles: req.body.full_lifecycles === '' || req.body.full_lifecycles === undefined
        ? null
        : Number(req.body.full_lifecycles),
      country: /^[A-Z]{2}$/.test(req.body.country || '') ? req.body.country : null,
      city: req.body.city || null,
      work_mode: req.body.work_mode || 'remote',
      willing_to_travel: req.body.willing_to_travel === 'on' ? 1 : 0,
      day_rate: req.body.day_rate || null,
      currency: /^[A-Z]{3}$/.test(req.body.currency || '') ? req.body.currency : 'EUR',
      availability: req.body.availability || 'not_available',
      available_from: req.body.available_from || null,
      linkedin_url: req.body.linkedin_url || null,
      website_url: req.body.website_url || null,
      sap_community_url: req.body.sap_community_url || null
    });

    const names = String(req.body.skills || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40);
    const skills = await Skill.findOrCreateMany(names);
    await Skill.setForConsultant(req.session.user.id, skills.map((s) => s.id));
    await ConsultantProfile.recomputeCompleteness(req.session.user.id);

    req.flash('success', 'Profile saved.');
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/visibility',
  isConsultant,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const wantPublic = req.body.is_public === 'on';
    const { published, completeness } = await ConsultantProfile.setPublic(req.session.user.id, wantPublic);

    if (wantPublic && !published) {
      req.flash(
        'error',
        `Your profile is ${completeness}% complete. It needs ${ConsultantProfile.MIN_COMPLETENESS_TO_PUBLISH}% before it can be listed.`
      );
    } else {
      req.flash('success', published ? 'Your profile is now listed in the directory.' : 'Your profile is hidden from the directory.');
    }
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/photo',
  isConsultant,
  writeLimiter,
  singleImage('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please choose an image.');
      return res.redirect('/profile/consultant');
    }

    try {
      await ImageBlob.put('consultant_photos', req.session.user.id, req.file.buffer, { size: 512 });
      await ConsultantProfile.setProfilePicture(
        req.session.user.id,
        ImageBlob.pointerUrl('/consultants/photo', req.session.user.id)
      );
      req.flash('success', 'Photo updated.');
    } catch (err) {
      // A file that survived the MIME check but will not decode was never an image.
      req.flash('error', 'That file could not be read as an image.');
    }
    return res.redirect('/profile/consultant');
  })
);

/**
 * Certifications are picked from the catalogue, not typed.
 *
 * The reference takes a free-text `name`, which is why "C_TS4FI", the full marketing title
 * and "S4 FI cert" are three credentials there. Here the posted value is a catalogue stem
 * or the reserved OTHER, and only OTHER carries text.
 */
router.post(
  '/consultant/certifications',
  isConsultant,
  writeLimiter,
  [
    body('code').custom((value) => {
      if (!isCertificationCode(value)) throw new Error('Choose a certification from the list.');
      return true;
    }),
    body('custom_name').custom((value, { req }) => {
      if (req.body.code === OTHER_CODE && !String(value || '').trim()) {
        throw new Error('Name the certification you hold.');
      }
      return true;
    })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/profile/consultant');
    }

    await ConsultantProfile.addCertification(req.session.user.id, {
      code: req.body.code,
      customName: req.body.custom_name || null,
      credentialId: req.body.credential_id || null,
      earnedOn: req.body.earned_on || null,
      expiresOn: req.body.expires_on || null
    });
    req.flash('success', 'Certification added.');
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/certifications/:id/delete',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await ConsultantProfile.removeCertification(req.session.user.id, req.params.id);
    req.flash('success', 'Certification removed.');
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/experience',
  isConsultant,
  writeLimiter,
  [
    body('company').trim().isLength({ min: 2, max: 180 }),
    body('title').trim().isLength({ min: 2, max: 180 }),
    body('started_on').isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Please fill in the company, title and start date.');
      return res.redirect('/profile/consultant');
    }

    await ConsultantProfile.addExperience(req.session.user.id, {
      company: req.body.company.trim(),
      title: req.body.title.trim(),
      startedOn: req.body.started_on,
      endedOn: req.body.is_current === 'on' ? null : req.body.ended_on || null,
      isCurrent: req.body.is_current === 'on',
      description: sanitizeRichText(req.body.description || '')
    });
    req.flash('success', 'Experience added.');
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/experience/:id/delete',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await ConsultantProfile.removeExperience(req.session.user.id, req.params.id);
    req.flash('success', 'Experience removed.');
    return res.redirect('/profile/consultant');
  })
);

/**
 * Delivery history — the section a hiring manager in this ecosystem reads first.
 *
 * The modules are the point. They feed the module filter in the talent directory and the
 * module term in the match score, so an engagement entered without them is a line of prose
 * that no search will ever find.
 */
router.post(
  '/consultant/projects',
  isConsultant,
  writeLimiter,
  [
    body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Give the engagement a name.'),
    body('activate_phase').optional({ checkFalsy: true }).isIn(Job.ACTIVATE_PHASES),
    body('product_line').optional({ checkFalsy: true }).isLength({ max: 64 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/profile/consultant');
    }

    const modules = (Array.isArray(req.body.modules) ? req.body.modules : [req.body.modules])
      .filter((slug) => slug && isModule(slug))
      .slice(0, 30);

    await ConsultantProfile.addProject(req.session.user.id, {
      name: req.body.name.trim(),
      client: req.body.client || null,
      productLine: req.body.product_line || null,
      role: req.body.role || null,
      activatePhase: req.body.activate_phase || null,
      isFullLifecycle: req.body.is_full_lifecycle === 'on',
      startedOn: req.body.started_on || null,
      endedOn: req.body.ended_on || null,
      description: sanitizeRichText(req.body.description || ''),
      modules
    });

    req.flash(
      'success',
      modules.length ? 'Engagement added.' : 'Engagement added. Add the modules it touched so it shows up in searches.'
    );
    return res.redirect('/profile/consultant');
  })
);

router.post(
  '/consultant/projects/:id/delete',
  isConsultant,
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await ConsultantProfile.removeProject(req.session.user.id, req.params.id);
    req.flash('success', 'Engagement removed.');
    return res.redirect('/profile/consultant');
  })
);

router.get(
  '/company',
  isCompany,
  asyncHandler(async (req, res) => {
    const company = await CompanyProfile.ensureExists(req.session.user.id, req.session.user.name);
    res.render('profile/company', { title: 'Your company profile', company, countries, errors: [] });
  })
);

router.post(
  '/company',
  isCompany,
  writeLimiter,
  [body('company_name').trim().isLength({ min: 2, max: 200 }).withMessage('Please enter the company name.')],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/profile/company');
    }

    await CompanyProfile.update(req.session.user.id, {
      company_name: req.body.company_name.trim(),
      tagline: req.body.tagline || null,
      about: sanitizeRichText(req.body.about || ''),
      industry: req.body.industry || null,
      company_size: req.body.company_size || null,
      company_type: ['end_customer', 'consulting_partner', 'isv', 'staffing'].includes(req.body.company_type)
        ? req.body.company_type
        : 'end_customer',
      website: req.body.website || null,
      linkedin_url: req.body.linkedin_url || null,
      country: /^[A-Z]{2}$/.test(req.body.country || '') ? req.body.country : null,
      city: req.body.city || null,
      is_public: req.body.is_public === 'on' ? 1 : 0
    });

    req.flash('success', 'Company profile saved.');
    return res.redirect('/profile/company');
  })
);

router.post(
  '/company/logo',
  isCompany,
  writeLimiter,
  singleImage('logo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please choose an image.');
      return res.redirect('/profile/company');
    }

    try {
      await ImageBlob.put('company_logos', req.session.user.id, req.file.buffer, { size: 512 });
      await CompanyProfile.setLogo(req.session.user.id, ImageBlob.pointerUrl('/companies/logo', req.session.user.id));
      req.flash('success', 'Logo updated.');
    } catch (err) {
      req.flash('error', 'That file could not be read as an image.');
    }
    return res.redirect('/profile/company');
  })
);

/**
 * Closing an account.
 *
 * Two steps, and the first one is the point: a page that says exactly what will be removed
 * and exactly what will be kept, with the reason beside each. Both lists come from
 * `AccountClosure`, so the promises on the page are made by the code that keeps them —
 * a list maintained separately from the operation is worse than no list.
 */
router.get(
  '/settings/close',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.session.user.id);
    if (!user) return res.status(404).render('errors/404', { title: 'Not found' });

    const { ok, problems } = await AccountClosure.blockers(user);

    return res.render('profile/close', {
      title: 'Close your account',
      user,
      canClose: ok,
      problems,
      removed: AccountClosure.REMOVED,
      kept: AccountClosure.KEPT
    });
  })
);

router.post(
  '/settings/close',
  passwordLimiter,
  [
    body('current_password').notEmpty().withMessage('Enter your password to confirm.'),
    body('understood').equals('on').withMessage('Tick the box to confirm you have read what happens.')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/profile/settings/close');
    }

    const user = await User.findById(req.session.user.id);
    /*
     * The password again, on the page that does the irreversible thing. The session alone
     * is not enough for this one: an unattended browser is the ordinary way somebody
     * else's hands end up on an account, and every other button here is recoverable.
     */
    if (!user || !(await User.verifyPassword(user, req.body.current_password))) {
      req.flash('error', 'That password is not correct.');
      return res.redirect('/profile/settings/close');
    }

    try {
      await AccountClosure.close(user.id, { reason: req.body.reason });

      /*
       * Signed out by destroying the session rather than by clearing the user off it: a
       * half-emptied session is one somebody could still be partly signed in on. It also
       * takes the flash queue with it, which is why the confirmation is a PAGE rather than
       * a message — there is nowhere left to put a message.
       */
      return req.session.destroy(() => res.redirect('/account-closed'));
    } catch (err) {
      if (['BLOCKED', 'ALREADY_CLOSED', 'NOT_FOUND'].includes(err.code)) {
        req.flash('error', err.message);
        return res.redirect('/profile/settings/close');
      }
      throw err;
    }
  })
);

module.exports = router;
