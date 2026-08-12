const { EventEmitter } = require('events');
const crypto = require('crypto');

const emitter = new EventEmitter();
const recentEvents = [];
const MAX_RECENT_EVENTS = 200;

const publish = (type, payload = {}, topics = []) => {
  const event = {
    id: crypto.randomUUID(),
    type,
    topics: Array.from(new Set(topics.filter(Boolean))),
    payload,
    createdAt: new Date().toISOString(),
  };
  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
  emitter.emit('event', event);
  return event;
};

const subscribe = (listener) => {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
};

const getRecentEvents = ({ afterId, topics = [] } = {}) => {
  const topicSet = new Set(topics);
  const startIndex = afterId ? recentEvents.findIndex((event) => event.id === afterId) + 1 : 0;
  return recentEvents
    .slice(Math.max(startIndex, 0))
    .filter((event) => !topicSet.size || event.topics.some((topic) => topicSet.has(topic)));
};

module.exports = {
  publish,
  subscribe,
  getRecentEvents,
};
