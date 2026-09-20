'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const Conversation = require('../models/Conversation');
const Application = require('../models/Application');
const ConsultantProfile = require('../models/ConsultantProfile');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const { isAuthenticated, isEmailVerified, isNavigation } = require('../middleware/auth');
const { ipLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { requireIdParam } = require('../utils/ids');
const { toPlainText } = require('../utils/sanitize');

const router = express.Router();

router.use(isAuthenticated);

/**
 * Sending is authenticated, but an authenticated account can still script unbounded
 * inserts at somebody. Each message writes a row and a notification, so it is throttled
 * per address rather than per session — an anonymous flood is not the threat here, a
 * logged-in one is.
 */
const sendLimiter = ipLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'You are sending messages too quickly. Please slow down.'
});

const startLimiter = ipLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'You have started a lot of conversations recently. Please try again later.'
});

/**
 * Notify the other side that a message arrived.
 *
 * Fire and forget with a key derived from the message id, so a retried submit or a
 * double-clicked button cannot produce two notifications for one message.
 */
function notifyRecipients({ recipientIds, senderName, conversationId, messageId, body }) {
  for (const userId of recipientIds) {
    Notification.emit({
      userId,
      type: 'message_received',
      title: `New message from ${senderName}`,
      body: toPlainText(body, 120),
      link: `/messages/${conversationId}`,
      dedupeKey: `message:${messageId}:${userId}`
    });
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const { rows, total } = await Conversation.listForUser(req.session.user.id, { limit, offset });

    res.render('messages/index', {
      title: 'Messages',
      conversations: rows,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/messages', req.query, p)
    });
  })
);

router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    res.json({ success: true, count: await Conversation.unreadCount(req.session.user.id) });
  })
);

/**
 * Open, or start, the thread for a subject.
 *
 * There is no way to start an unanchored conversation. A thread is either about an
 * application both parties are already part of, or an enquiry about a specific job — and in
 * the enquiry case one of the two must own that job. That is what keeps this from being a
 * channel for contacting arbitrary accounts, and `models/Conversation.js` plus the CHECK in
 * migration 008 hold the same line underneath this handler rather than trusting it.
 */
router.post(
  '/start',
  isEmailVerified,
  startLimiter,
  asyncHandler(async (req, res) => {
    const actorId = req.session.user.id;
    const kind = req.body.kind === 'enquiry' ? 'enquiry' : 'application';

    let participantIds;
    let jobId = null;
    let applicationId = null;

    if (kind === 'application') {
      const application = await Application.findById(Number(req.body.application_id));
      if (!application) return res.status(404).render('errors/404', { title: 'Not found' });

      const isApplicant = application.consultant_user_id === actorId;
      const isEmployer = application.company_user_id === actorId;
      if (!isApplicant && !isEmployer) {
        return res.status(404).render('errors/404', { title: 'Not found' });
      }

      applicationId = application.id;
      jobId = application.job_id;
      participantIds = [application.consultant_user_id, application.company_user_id];
    } else {
      const job = await Job.findById(Number(req.body.job_id));
      if (!job) return res.status(404).render('errors/404', { title: 'Not found' });

      const recipientId = Number(req.body.recipient_user_id);
      if (!Number.isInteger(recipientId) || recipientId === actorId) {
        req.flash('error', 'That recipient is not valid.');
        return res.redirect('/messages');
      }

      const actorOwnsJob = job.company_user_id === actorId;
      const recipientOwnsJob = job.company_user_id === recipientId;

      if (actorOwnsJob) {
        // The employer may only open a thread with a consultant who has chosen to be
        // listed. A hidden profile is not a mailbox.
        const profile = await ConsultantProfile.findByUserId(recipientId);
        if (!profile || !profile.is_public) {
          req.flash('error', 'That consultant is not listed in the directory.');
          return res.redirect('/messages');
        }
      } else if (recipientOwnsJob) {
        // A consultant may contact the advertiser of an open job, and nobody else.
        if (job.status !== 'open') {
          req.flash('error', 'That role is no longer open.');
          return res.redirect('/messages');
        }
      } else {
        return res.status(404).render('errors/404', { title: 'Not found' });
      }

      jobId = job.id;
      participantIds = [actorId, recipientId];
    }

    const conversationId = await Conversation.findOrCreate({
      kind,
      applicationId,
      jobId,
      participantIds,
      createdByUserId: actorId
    });

    const opening = Conversation.normaliseBody(req.body.body);
    if (opening) {
      const posted = await Conversation.postMessage(conversationId, actorId, opening);
      notifyRecipients({
        recipientIds: posted.recipientIds,
        senderName: req.session.user.name,
        conversationId,
        messageId: posted.messageId,
        body: posted.body
      });
    }

    return res.redirect(`/messages/${conversationId}`);
  })
);

router.get(
  '/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;

    // `forParticipant` joins on membership, so a non-member simply gets nothing.
    const conversation = await Conversation.forParticipant(req.params.id, userId);
    if (!conversation) return res.status(404).render('errors/404', { title: 'Not found' });

    const [messages, participants] = await Promise.all([
      Conversation.messages(conversation.id),
      Conversation.participants(conversation.id)
    ]);

    // Opening the thread is what marks it read. Doing it after loading the messages means
    // the page still shows which ones were new.
    await Conversation.markRead(conversation.id, userId);

    return res.render('messages/show', {
      title: conversation.job_title ? `Messages — ${conversation.job_title}` : 'Messages',
      conversation,
      messages,
      participants,
      other: participants.find((p) => p.user_id !== userId) || null,
      maxLength: Conversation.MAX_BODY_LENGTH
    });
  })
);

router.post(
  '/:id/reply',
  requireIdParam('id'),
  isEmailVerified,
  sendLimiter,
  [body('body').trim().notEmpty().withMessage('Write something before sending.')],
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;

    /*
     * `isNavigation` from middleware/auth.js, not a private copy.
     *
     * The reference declares its own `wantsJson` here, which is the same predicate written
     * a second time — and the two disagree, because this one treats a request with no
     * `Sec-Fetch-Dest` as a fetch while the auth guard treats it as a navigation. A plain
     * Node client would therefore be redirected by the guard and answered in JSON by the
     * handler behind it. One predicate, in one place.
     */
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      if (!isNavigation(req)) return res.status(422).json({ success: false, error: errors.array()[0].msg });
      req.flash('error', errors.array()[0].msg);
      return res.redirect(`/messages/${req.params.id}`);
    }

    try {
      const posted = await Conversation.postMessage(req.params.id, userId, req.body.body);
      notifyRecipients({
        recipientIds: posted.recipientIds,
        senderName: req.session.user.name,
        conversationId: req.params.id,
        messageId: posted.messageId,
        body: posted.body
      });

      if (!isNavigation(req)) return res.json({ success: true, messageId: posted.messageId });
    } catch (err) {
      if (err.code === 'NOT_A_PARTICIPANT') return res.status(404).render('errors/404', { title: 'Not found' });
      if (err.code === 'EMPTY_MESSAGE') {
        req.flash('error', err.message);
        return res.redirect(`/messages/${req.params.id}`);
      }
      throw err;
    }

    return res.redirect(`/messages/${req.params.id}`);
  })
);

module.exports = router;
