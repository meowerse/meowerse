// Deterministic fixtures for the tier-A mock backend (PR-0). Everything derives from a fixed seed and a
// fixed epoch, so two runs produce byte-identical API responses. No real data, names or credentials.
export type Reaction = { emoji: string; count: number; mine: boolean };
export type Msg = {
  id: string; chatId: string; senderId: string; body: string; createdAt: number;
  replyToId?: string | null; replyTo?: { id: string; senderId: string; body: string } | null;
  editedAt?: number | null; isDeleted?: boolean; reactions?: Reaction[];
};
export type ChatFx = {
  id: string; key: string; type: "direct" | "group" | "channel"; name: string | null; peerId: string | null;
  peerUsername: string | null; peerDisplayName: string | null; unread: boolean; memberCount: number;
  messages: Msg[]; marker: string; members: Member[];
};
export type Member = { userId: string; username: string; displayName: string | null; avatarUrl: null; role: string; joinedAt: number };

export const EPOCH = Date.UTC(2026, 9, 1, 12, 0, 0);
export const ME = { id: "u_me", username: "perf_me", displayName: "Perf Me", avatarUrl: null, verified: true };

/** mulberry32: tiny seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LATIN = ["ok sounds good", "can you look at the deploy log when you get a minute", "lol", "the build is green again", "meeting moved to 15:30", "thanks!", "I pushed the fix, please re-run the checks and tell me if the flaky one fails again"];
const CYR = ["привет, как дела?", "давай созвонимся после обеда, нужно обсудить релиз и список задач на неделю", "ок, принято", "посмотри пожалуйста логи, там что-то странное с таймаутами при подключении", "спасибо огромное"];
const LINKS = ["docs here: https://example.com/docs/getting-started?ref=perf and the board https://example.org/board/42", "see https://example.net/a/very/long/path/that/keeps/going/and/going/index.html#section-3"];
const CODE = ["try `bun run build` first", "```\nconst x = await fetch('/api/chats');\nconsole.log(x.status);\n```", "use `git rebase --onto origin/master HEAD~3`"];
const EMOJI = ["🎉🎉🎉", "😂 that is great", "👀", "🚀 shipped", "✨ nice ✨"];
const LONG = "This one is deliberately long so the bubble wraps over several lines on a phone viewport: " + "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(4).trim();
const POOLS = [LATIN, CYR, LINKS, CODE, EMOJI, [LONG]];

const pad = (n: number, w = 5) => String(n).padStart(w, "0");

function makeMessages(chatId: string, key: string, count: number, senders: string[], seed: number): Msg[] {
  const r = rng(seed);
  const out: Msg[] = [];
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const pool = POOLS[Math.floor(r() * POOLS.length)]!;
    let body = pool[Math.floor(r() * pool.length)]!;
    const m: Msg = {
      id: `m_${key}_${pad(i)}`, chatId, senderId: senders[Math.floor(r() * senders.length)]!,
      body, createdAt: EPOCH + i * 60_000 + Math.floor(r() * 30_000),
    };
    if (!last) {
      const roll = r();
      if (roll < 0.08 && i > 5) {
        const t = out[Math.floor(r() * out.length)]!;
        m.replyToId = t.id;
        m.replyTo = { id: t.id, senderId: t.senderId, body: t.body.slice(0, 80) };
      } else if (roll < 0.16) m.reactions = [{ emoji: "👍", count: 1 + Math.floor(r() * 4), mine: r() < 0.3 }, ...(r() < 0.4 ? [{ emoji: "❤️", count: 1, mine: false }] : [])];
      else if (roll < 0.21) { m.editedAt = m.createdAt + 5000; m.body = body + " (edited)"; }
      else if (roll < 0.25) { m.isDeleted = true; m.body = ""; }
    } else {
      m.senderId = senders[0]!; // the unique marker is the last message of every chat, never deleted/edited
      m.body = `PERF-MARK::${key}`;
    }
    out.push(m);
  }
  return out;
}

function roster(n: number, seed: number): Member[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    userId: i === 0 ? ME.id : `u_${pad(i, 3)}`, username: i === 0 ? ME.username : `member${pad(i, 3)}`,
    displayName: i % 7 === 0 ? null : `Member ${i} ${["Ёлкин", "Smith", "Нова", "Okafor"][Math.floor(r() * 4)]}`,
    avatarUrl: null, role: i === 0 ? "owner" : i < 4 ? "admin" : "member", joinedAt: EPOCH - i * 3_600_000,
  }));
}

type Spec = { key: string; type: ChatFx["type"]; name: string | null; count: number; members: number; unread: boolean; peer?: [string, string] };
const SPECS: Spec[] = [
  { key: "dm300", type: "direct", name: null, count: 300, members: 2, unread: false, peer: ["ada", "Ada Лавлейс"] },
  { key: "grp1000", type: "group", name: "platform-team", count: 1000, members: 40, unread: false },
  { key: "chan60", type: "channel", name: "release-notes", count: 60, members: 25, unread: false },
  { key: "dm80a", type: "direct", name: null, count: 80, members: 2, unread: true, peer: ["boris", "Борис"] },
  { key: "dm80b", type: "direct", name: null, count: 80, members: 2, unread: true, peer: ["chloe", "Chloe"] },
  { key: "dm80c", type: "direct", name: null, count: 80, members: 2, unread: true, peer: ["dmitri", "Dmitri"] },
  { key: "grp120", type: "group", name: "weekend-plans", count: 120, members: 8, unread: false },
  { key: "dm40", type: "direct", name: null, count: 40, members: 2, unread: false, peer: ["eve", "Eve"] },
];

export function buildFixtures(): ChatFx[] {
  return SPECS.map((s, idx) => {
    const id = `c_${s.key}`;
    const members = s.type === "direct" ? [] : roster(s.members, 1000 + idx);
    const senders = s.type === "direct" ? [`u_peer_${s.key}`, ME.id] : members.map((m) => m.userId).slice(0, Math.min(members.length, 12));
    return {
      id, key: s.key, type: s.type, name: s.name, peerId: s.type === "direct" ? senders[0]! : null,
      peerUsername: s.peer?.[0] ?? null, peerDisplayName: s.peer?.[1] ?? null, unread: s.unread,
      memberCount: s.members, messages: makeMessages(id, s.key, s.count, senders, 7000 + idx), marker: `PERF-MARK::${s.key}`, members,
    };
  });
}

export const summary = (c: ChatFx, order: number) => {
  const last = c.messages[c.messages.length - 1]!;
  return {
    id: c.id, type: c.type, name: c.name, lastMessage: last.body, lastSenderId: last.senderId,
    lastActivity: EPOCH + 1_000_000_000 - order * 60_000, unreadCount: c.unread ? 1 : 0, memberCount: c.memberCount,
    peerId: c.peerId, peerUsername: c.peerUsername, peerDisplayName: c.peerDisplayName, peerAvatarUrl: null,
  };
};

/** Fixture self-check: the marker is present exactly once, as the last message, in every chat. Throws on drift. */
export function selfCheck(fx: ChatFx[]): void {
  const want: Record<string, number> = { dm300: 300, grp1000: 1000 };
  for (const c of fx) {
    const hits = c.messages.filter((m) => m.body === c.marker);
    if (hits.length !== 1 || c.messages[c.messages.length - 1]!.body !== c.marker) throw new Error(`fixture ${c.key}: marker not unique/last`);
    if (want[c.key] && c.messages.length !== want[c.key]) throw new Error(`fixture ${c.key}: expected ${want[c.key]} messages`);
    if (c.type !== "direct" && c.members.length !== c.memberCount) throw new Error(`fixture ${c.key}: roster size mismatch`);
  }
  if (fx.length !== 8) throw new Error("expected 8 chats");
}
