'use strict';

const express = require('express');

const Notification = require('../models/Notification');
const { isAuthenticated, isNavigation } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

const router = express.Router();

router.use(isAuthenticated);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 30 });
    const rows = await Notification.listFor(req.session.user.id, { limit, offset });

    res.render('dashboard/notifications', {
      title: 'Notifications',
      notifications: rows,
      pagination: paginationMeta({ page, perPage, total: rows.length + offset }),
      pageUrl: (p) => pageUrl('/notifications', req.query, p)
    });
  })
);

router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    res.json({ success: true, count: await Notification.unreadCount(req.session.user.id) });
  })
);

/**
 * The latest few, for the Notifications section of the user menu.
 *
 * Fetched when the menu opens rather than rendered with every page. Only same-site links
 * leave here: `link` is written by our own emitters today, and the menu turns it into an
 * href, so anything that is not a plain path is dropped rather than trusted.
 */
const RECENT_LIMIT = 5;

function sameSiteLink(link) {
  return typeof link === 'string' && /^\/(?![/\\])/.test(link) ? link : null;
}

router.get(
  '/recent',
  asyncHandler(async (req, res) => {
    const userId = req.session.user.id;
    const [rows, unread] = await Promise.all([
      Notification.listFor(userId, { limit: RECENT_LIMIT }),
      Notification.unreadCount(userId)
    ]);

    res.json({
      success: true,
      unread,
      notifications: rows.map((n) => ({
        id: n.id,
        title: n.title,
        link: sameSiteLink(n.link),
        read: Boolean(n.read_at),
        // The same format as the list page, so the two never show one event at two times.
        when: new Date(n.created_at).toISOString().slice(0, 16).replace('T', ' ')
      }))
    });
  })
);

router.post(
  '/:id/read',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    await Notification.markRead(req.session.user.id, req.params.id);
    if (req.get('sec-fetch-dest') && req.get('sec-fetch-dest') !== 'document') {
      return res.json({ success: true });
    }
    return res.redirect('/notifications');
  })
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const count = await Notification.markAllRead(req.session.user.id);
    // The user menu posts this from a fetch and stays where it is.
    if (!isNavigation(req)) return res.json({ success: true, count });
    req.flash('success', `${count} notification(s) marked as read.`);
    return res.redirect('/notifications');
  })
);

module.exports = router;
