'use strict';

const express = require('express');

const Notification = require('../models/Notification');
const { isAuthenticated } = require('../middleware/auth');
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
    req.flash('success', `${count} notification(s) marked as read.`);
    return res.redirect('/notifications');
  })
);

module.exports = router;
