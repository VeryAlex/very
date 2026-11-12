
'use strict';

const clients = new Map();

function addClient(res, user) {
  const clientId = Symbol('sse-client');

  clients.set(clientId, {
    res,
    user: {
      id: String(user.id),
      role: user.role
    }
  });

  res.write('retry: 3000\n');
  res.write(': connected\n\n');

  return () => {
    clients.delete(clientId);
  };
}

function publish(event, data, allowed = () => true) {
  const packet =
    `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n\n`;

  for (const [id, client] of clients) {
    try {
      if (allowed(client.user)) {
        client.res.write(packet);
      }
    } catch {
      clients.delete(id);
    }
  }
}

function getClientCount() {
  return clients.size;
}

function closeAllClients() {
  for (const [id, client] of clients) {
    try {
      client.res.end();
    } catch (error) {
      console.error('SSE CLOSE ERROR:', error.message);
    } finally {
      clients.delete(id);
    }
  }
}

module.exports = {
  addClient,
  publish,
  getClientCount,
  closeAllClients
};
