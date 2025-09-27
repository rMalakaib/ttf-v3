// src/api/realtime-sse/services/pubsub.ts
import { randomUUID } from 'node:crypto';

type Topic = string;
type SubId = string;
type Handler = (msg: { id: string; topic: string; event: string; data: any }) => void;

type Sub = {
  id: string;
  userId?: number;
  send: (frame: { id: string; event: string; data?: any }) => void;
  close: () => void;
};

const subscribers = new Map<SubId, { topics: Set<Topic>; handler: Handler }>();
const topicIndex  = new Map<Topic, Set<SubId>>();

type Payload = Record<string, unknown>;
type FinalNotice = { event: string; data?: any };
type DisconnectOpts = { finalNotice?: FinalNotice };

// 🔹 NEW: who owns each subscription, and reverse index by user
const subOwner   = new Map<SubId, number>();
const userIndex  = new Map<number, Set<SubId>>();

// NEW: per-subscription "closer" to end the HTTP stream
const subCloser  = new Map<SubId, () => void>();


export default ({ strapi }) => ({
  
  isOwnedBy(id: SubId, userId: number): boolean {
  return subOwner.get(id) === userId;
  },

  getTopics(id: SubId): string[] {
    const sub = subscribers.get(id);
    return sub ? Array.from(sub.topics) : [];
  },


    // Remove everyone from ONE exact topic (keep sockets open)
  // Remove everyone from ONE exact topic (keep sockets open)
  disconnectTopic(topic: Topic) {
    const ids = topicIndex.get(topic);
    if (!ids?.size) return 0;

    // 1) Politely notify each subscriber they're being unsubscribed from this topic
    for (const subId of Array.from(ids)) {
      const sub = subscribers.get(subId);
      if (sub) {
        try {
          sub.handler({
            id: randomUUID(),
            topic,
            event: 'system:unsubscribed',
            data: { topics: [topic], reason: 'server-prune' },
          });
        } catch {}
      }
    }

    // 2) Detach mappings (topic <-> sub) but keep sockets alive
    let n = 0;
    for (const subId of Array.from(ids)) {
      ids.delete(subId);                    // detach subId from the topic index
      const sub = subscribers.get(subId);
      sub?.topics.delete(topic);            // detach topic from the subscriber
      n++;
    }
    topicIndex.delete(topic);               // no subs remain for this topic
    return n;
  },

  // Remove everyone from ALL topics starting with a prefix (e.g., "question:<filingId>:")
  disconnectTopicPrefix(prefix: string) {
  // Snapshot all matching topics first
  const toClear: Topic[] = [];
  for (const t of topicIndex.keys()) {
    if (t.startsWith(prefix)) toClear.push(t);
  }
  if (!toClear.length) return 0;

  // 1) Group topics per subscriber so they get a single polite notice
  const topicsBySub = new Map<SubId, Topic[]>();
  let total = 0;

  for (const t of toClear) {
    const ids = topicIndex.get(t);
    const size = ids?.size ?? 0;
    total += size;
    if (!ids || !size) continue;
    for (const subId of ids) {
      if (!topicsBySub.has(subId)) topicsBySub.set(subId, []);
      topicsBySub.get(subId)!.push(t);
    }
  }

  for (const [subId, topics] of topicsBySub) {
    const sub = subscribers.get(subId);
    if (!sub) continue;
    try {
      sub.handler({
        id: randomUUID(),
        topic: prefix, // informational; client can use data.topics for exact list
        event: 'system:unsubscribed',
        data: { topics, reason: 'server-prune', topicPrefix: prefix },
      });
    } catch {}
  }

  // 2) Detach all mappings without closing sockets
  for (const t of toClear) {
    const ids = topicIndex.get(t);
    if (!ids) continue;
    for (const subId of Array.from(ids)) {
      ids.delete(subId);
      const sub = subscribers.get(subId);
      sub?.topics.delete(t);
    }
    topicIndex.delete(t);
  }

  return total;
},

  // Convenience: nuke the filing channel and all question channels under it
  disconnectFilingChannels(filingId: string) {
  // Keep sockets alive; clients will also see your domain 'filing:deleted' publish.
  const a = this.disconnectTopic(`filing:${filingId}`);
  const b = this.disconnectTopicPrefix(`question:${filingId}:`); // covers 3- and 4-part forms
  return a + b;
},

  publish(topic: Topic, a: string, b: string | Payload, c?: Payload) {
    const hasId = typeof c !== 'undefined';
    const id    = hasId ? a             : randomUUID();
    const event = hasId ? (b as string) : (a as string);
    const data  = hasId ? (c as Payload) : (b as Payload);

    // optional runtime guard to catch mistakes
    if (data === null || typeof data !== 'object') {
      throw new Error('pubsub.publish requires an object payload');
    }

    const subs = topicIndex.get(topic);
    const delivered = subs?.size ?? 0;

    if (subs) {
      for (const subId of subs) {
        subscribers.get(subId)?.handler({ id, topic, event, data });
      }
    }
    return delivered;
  },

  subscribe(topics: Topic[], handler: Handler) {
    const id: SubId = randomUUID();
    subscribers.set(id, { topics: new Set(topics), handler });
    for (const t of topics) {
      if (!topicIndex.has(t)) topicIndex.set(t, new Set());
      topicIndex.get(t)!.add(id);
    }
    return id;
  },

  // 🔹 NEW: tag a subscription with a userId (call this once right after subscribe)
  tagSubscriber(id: SubId, userId: number) {
    subOwner.set(id, userId);
    if (!userIndex.has(userId)) userIndex.set(userId, new Set());
    userIndex.get(userId)!.add(id);
  },

  // NEW: controller can register a closer for this subscription
  registerCloser(id: SubId, closer: () => void) {
    subCloser.set(id, closer);
  },

  // NEW: kick a single subscription (close socket + unsubscribe)
  kick(id: SubId) {
  // Send a deterministic final frame before closing
    const sub = subscribers.get(id);
    if (sub) {
      try {
        sub.handler({
          id: randomUUID(),
          topic: 'system',
          event: 'system:kicked',
          data: { reason: 'server-kick' },
        });
      } catch {}
    }

    // Give the event a moment to flush, then close & unsubscribe
    const closer = subCloser.get(id);
    if (closer) {
      try { setTimeout(() => { try { closer(); } catch {} }, 50); } catch {}
    }
    subCloser.delete(id);
    this.unsubscribe(id);
  },

  // 🔹 NEW: disconnect ALL live SSE subs owned by a user
  disconnectAllForUser(userId: number, projectId: string) {
    const ids = userIndex.get(userId);
    if (!ids?.size) return 0;

    // 1) Final event on each connection
    for (const id of ids) {
      const sub = subscribers.get(id);
      if (!sub) continue;
      try {
        sub.handler({
          id: randomUUID(),
          topic: 'system',
          event: 'system:kicked',
          data: { projectId: projectId, reason: 'permission-change', userId },
        });
      } catch {}
    }

    // 2) Close each after a short flush window, then unsubscribe
    for (const id of Array.from(ids)) {
      const closer = subCloser.get(id);
      if (closer) {
        try { setTimeout(() => { try { closer(); } catch {} }, 50); } catch {}
      }
      subCloser.delete(id);
      this.unsubscribe(id);
    }

    userIndex.delete(userId);
    return ids.size;
},

  unsubscribe(id: SubId, topics?: Topic | Topic[]) {
  const sub = subscribers.get(id);
  if (!sub) return;

  // ---- Partial unsubscribe path ----
  if (typeof topics !== 'undefined') {
    const list = Array.isArray(topics) ? topics : [topics];
    const removed: Topic[] = [];

    for (const t of list) {
      if (!sub.topics.has(t)) continue;
      sub.topics.delete(t);
      const ids = topicIndex.get(t);
      ids?.delete(id);
      if (ids && ids.size === 0) topicIndex.delete(t);
      removed.push(t);
    }

    // Notify the client about the specific topics they were unsubscribed from
    if (removed.length) {
      try {
        sub.handler({
          id: randomUUID(),
          topic: removed.length === 1 ? removed[0] : 'system',
          event: 'system:unsubscribed',
          data: { topics: removed, reason: 'client-unsubscribe' },
        });
      } catch {}
    }

    // If no topics remain, clean up the whole sub as before
    if (sub.topics.size === 0) {
      const owner = subOwner.get(id);
      if (typeof owner === 'number') {
        const set = userIndex.get(owner);
        if (set) {
          set.delete(id);
          if (!set.size) userIndex.delete(owner);
        }
      }
      subOwner.delete(id);
      subscribers.delete(id);
    }
    return;
  }

  // ---- Full unsubscribe path (legacy behavior) ----
  // Remove from per-user index if present
  const owner = subOwner.get(id);
  if (typeof owner === 'number') {
    const set = userIndex.get(owner);
    if (set) {
      set.delete(id);
      if (!set.size) userIndex.delete(owner);
    }
  }
  subOwner.delete(id);

  // Detach from all topics
  for (const t of sub.topics) {
    const ids = topicIndex.get(t);
    ids?.delete(id);
    if (ids && ids.size === 0) topicIndex.delete(t);
  }

  // Finally drop subscriber
  subscribers.delete(id);
},

// 🔹 NEW: add topics to an existing subscription (idempotent)
  addTopics(id: SubId, topics: Topic[]) {
    const sub = subscribers.get(id);
    if (!sub) throw new Error('Unknown subscription id');

    const added: Topic[] = [];
    const already: Topic[] = [];

    for (const raw of topics) {
      const t = String(raw ?? '').trim();
      if (!t) continue;
      if (sub.topics.has(t)) { already.push(t); continue; }

      sub.topics.add(t);
      if (!topicIndex.has(t)) topicIndex.set(t, new Set());
      topicIndex.get(t)!.add(id);
      added.push(t);
    }

    // Inform the client (single frame, mirrors your unsubscribe notice)
    if (added.length) {
      try {
        sub.handler({
          id: randomUUID(),
          topic: added.length === 1 ? added[0] : 'system',
          event: 'system:subscribed',
          data: { topics: added },
        });
      } catch {}
    }
    return { added, already };
  },
});
