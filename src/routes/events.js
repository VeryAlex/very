
'use strict';

const { getUser } = require('../auth');
const { addClient } = require('../services/realtime');

async function handleEvents(req, res, db, url) {
  if (url.pathname !== '/api/events' || req.method !== 'GET') {
    return false;
  }

  try {
    const user = await getUser(req, db);

    if (!user) {
      res.writeHead(401, {
        'Cache-Control': 'no-store'
      });
      res.end();
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.flushHeaders?.();

    const removeClient = addClient(res, user);

    const heartbeat = setInterval(() => {
      if (!res.destroyed) {
        res.write(': ping\n\n');
      }
    }, 25000);

    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;

      clearInterval(heartbeat);
      removeClient();
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);

    return true;
  } catch (error) {
    console.error('SSE ERROR:', error.message);

    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }

    return true;
  }
}

module.exports = { handleEvents };
