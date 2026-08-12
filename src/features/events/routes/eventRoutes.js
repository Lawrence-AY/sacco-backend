const express = require('express');
const jwtUtils = require('../../../shared/utils/jwt');
const db = require('../../../models');
const eventBus = require('../../../services/realtime/eventBus');

const router = express.Router();

const getTopicsForUser = async (user) => {
  const role = String(user.role || '').toUpperCase();
  const topics = [`user:${user.id}`];
  if (['ADMIN', 'SUPERADMIN'].includes(role)) topics.push('admin:dashboard', 'finance:dashboard');
  if (role === 'FINANCE') topics.push('finance:dashboard');
  return topics;
};

const authenticateEventStream = async (req, res, next) => {
  try {
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    const token = bearer || req.cookies?.accessToken || req.query.access_token;
    if (!token) return res.status(401).end();
    const decoded = jwtUtils.verifyToken(token);
    const user = await db.User.findByPk(decoded.id);
    if (!user) return res.status(401).end();
    req.user = user;
    return next();
  } catch {
    return res.status(401).end();
  }
};

router.get('/', authenticateEventStream, async (req, res) => {
  const topics = await getTopicsForUser(req.user);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event) => {
    if (!event.topics.some((topic) => topics.includes(topic))) return;
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
  };

  eventBus.getRecentEvents({ afterId: req.get('Last-Event-ID') || req.query.after, topics }).forEach(send);
  const unsubscribe = eventBus.subscribe(send);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

module.exports = router;
