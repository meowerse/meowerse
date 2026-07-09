/**
 * lolnekobot — Telegram chat bot on Cloudflare Workers
 *
 * Replies are returned in the webhook response body (zero extra requests).
 * Auth: secret embedded in the webhook URL path (PATH_SECRET).
 * State: KV namespace (binding BOT_KV) for sleep-mode dedup.
 */

/**
 * @typedef {Object} Rule
 * @property {RegExp}   [pattern]
 * @property {Function} [match]   (text, msg) => replyString | null
 * @property {string | ((msg: any) => string)} [reply]
 */

const pick = a => a[Math.floor(Math.random() * a.length)];

// ── Catspeak token table ─────────────────────────────────────────────────────
// kind: 'cat'  = unambiguous cat sound (a real signal)
//       'face' = cute face / emoji / heart (also a signal, but defers when alone)
//       'frag' = ambiguous fragment (only counts when repeated)
const CAT_SOUNDS = [
  // English cat sounds
  { re: /^m+[eiy]*a*[ou]+w*$/iu, kind: 'cat' },  // meow, miaow, myaow, miau, miao
  { re: /^m+e+w+$/iu,            kind: 'cat' },  // mew
  { re: /^n+y+a+n*$/iu,          kind: 'cat' },  // nya, nyan
  { re: /^p+u+r+$/iu,            kind: 'cat' },  // pur, purr
  { re: /^m+r+o+w+p*$/iu,        kind: 'cat' },  // mrow, mrrowp
  { re: /^m+r+p+$/iu,            kind: 'cat' },  // mrrp
  { re: /^r+a+w+r+$/iu,          kind: 'cat' },  // rawr
  { re: /^c+h+i+r+p+$/iu,        kind: 'cat' },  // chirp
  { re: /^[bp]+r+[tp]+$/iu,      kind: 'cat' },  // brrt, brrp, prrt
  { re: /^f+u+r{2,}$/iu,         kind: 'cat' },  // furr
  { re: /^f+r{2,}$/iu,           kind: 'cat' },  // frr
  { re: /^m+l+e+m+$/iu,          kind: 'cat' },  // mlem
  { re: /^b+l+e+p+$/iu,          kind: 'cat' },  // blep
  { re: /^(?:p+s+){2,}$/iu,      kind: 'cat' },  // pspsps
  // Russian cat sounds
  { re: /^м+я+[увфкн]*$/iu,      kind: 'cat' },  // мяу, мяв, мяф, мяк, мявк
  { re: /^м+и+[яуаове]*[увкн]*$/iu, kind: 'cat' }, // мияу, миу, мио
  { re: /^м+у+р+л*ы*к*$/iu,      kind: 'cat' },  // мур, мурр, мурл, мурлык
  { re: /^м+р+[ауяыео]+[увфкн]*$/iu, kind: 'cat' }, // мрау, мря
  { re: /^м+р*$/iu, kind: 'cat' }, // мр, мрррр
  { re: /^н+я+[нвфку]*$/iu,      kind: 'cat' },  // ня, нян, няв, няф, няк
  { re: /^ф+ы*р+$/iu,            kind: 'cat' },  // фыр, фырр, фрр
  { re: /^(?:п+с+){2,}$/iu,      kind: 'cat' },  // пспспс

  // Ambiguous fragments — only count when repeated
  { re: /^p+r+$/iu,  kind: 'frag' },  // prr
  { re: /^m+r+$/iu,  kind: 'frag' },  // mrr
  { re: /^м+р+$/iu,  kind: 'frag' },  // мр
  { re: /^к+[иы]+с+$/iu, kind: 'frag' }, // кис, кыс

  // Cute faces / kaomoji / hearts / emoji
  { re: /^[:=;]+[3зЗ]+$/u,        kind: 'face' }, // :3  :з  =3  :33
  { re: /^[uoуо]+[wвuу][uoуо]+$/iu, kind: 'face' }, // uwu, owo
  { re: /^\^[_w^.]*\^$/iu,        kind: 'face' }, // ^^, ^_^, ^w^
  { re: /^[>＞]+[wшvв]+[<＜]+$/iu, kind: 'face' }, // >w
  { re: /^(?:<3+|❤+|♥+|💜+|🧡+|💛+|💚+|💙+|🩷+|🤍+|🖤+)$/u, kind: 'face' }, // <3 & hearts (incl. 💙)
  { re: /^[🐱🐈😺😸😻🙀😼😽😾🐾]+$/u, kind: 'face' }, // cat emoji
];

// Laughter / cutesy filler that's safe to ignore between cat sounds.
// (Never triggers on its own — there must be a real cat signal too.)
const FILLERS = [
  /^(?:l+o+l+|le+l|lma+o+|ro+fl+|x+d+|hh+|(?:ha|he|hi|ho){2,}|a?haha+)$/i,
  /^(?:(?:ах|ха|хе|хи|хо|хы|хъ){2,}[аеиоуы]*|кек+|ло+л|о+ру*|тс+)$/iu,
];

// The bot's own voice, for varied replies.
const CAT_REPLIES = ['nya~', 'nyaa', 'meow', 'mrrp', 'purrr', 'mrrr', 'мяу', 'мур', 'мурр', 'фыр', 'ня', 'мрау'];
const CAT_TAILS      = ['', '', '', '', '~', ' 🐾', ' 😺', ' 😻', ' :3', ' 💙'];
const CAT_TAILS_HYPE = ['!', '~', '!!', ' 😻', ' 🐾😻', ' 😸💕', '!!~', ' 💙'];

// Classify a whole message; return a dynamic reply, or null if not catspeak.
function catspeakReply(text) {
  const raw = (text || '').trim();
  const tokens = raw.split(/[\s!.?~,–—()-]+/u).filter(Boolean);
  if (!tokens.length) return null;

  let cat = 0, face = 0, frag = 0, filler = 0;
  for (const t of tokens) {
    const sound = CAT_SOUNDS.find(c => c.re.test(t));
    if (sound) { sound.kind === 'cat' ? cat++ : sound.kind === 'face' ? face++ : frag++; continue; }
    if (FILLERS.some(r => r.test(t))) { filler++; continue; }
    return null;                       // a real word cancels the whole message
  }

  let signal = cat + face;
  if (signal === 0) {
    if (frag >= 2 && filler === 0) signal = frag;  // e.g. "кис кис"
    else return null;
  }
  // A lone single face/fragment with no laughter defers to its dedicated rule.
  if (cat === 0 && (face + frag) === 1 && filler === 0) return null;

  const excited = /(.)\1\1/u.test(raw) || /!{2,}/.test(text);
  const base = Math.random() < 0.7 ? raw.slice(0, 60) : pick(CAT_REPLIES);
  return (base + pick(excited ? CAT_TAILS_HYPE : CAT_TAILS)).slice(0, 64);
}

/** @type {Rule[]} */
const RULES = [
  // Signature phrases
  { pattern: /мяу\s+или\s+не\s+мяу/iu,   reply: 'мяу'  },
  { pattern: /meow\s+or\s+not\s+meow/iu, reply: 'meow' },

  // Catspeak → dynamic mirror (sounds + faces + light laughter; protected)
  { match: text => catspeakReply(text) },

  // Lone cat emoji → a random cat reaction
  { pattern: /^[\s]*[🐱🐈😺😸😻🙀😼😽😾🐾]+[\s]*$/u, reply: () => pick(['😺', '😸', '😻', '🐾', 'nya~']) },

  // Praise → purr
  { pattern: /\b(good|best)\s+(cat|kitty|kitten|boy|boi|girl)\b/i, reply: () => pick(['purr 😻', 'mrrr 😽', 'nya~ 😻']) },
  { pattern: /хорош(ий|ая|енький|енькая)\s+(кот|кошка|котик|кошечка|кот[её]нок|мальчик|девочка|кис(а|ка))/iu, reply: () => pick(['мур 😻', 'мрр 😽', 'мяу~ 😻']) },

  // uwu / owo (whole message)
  { pattern: /^[\s]*([uo]w[uo][\s!~.]*)+$/i, reply: () => pick(['uwu~', 'owo', 'uwu 🐾']) },

  // :3  /  :з (whole message)
  { pattern: /^[\s]*[:=][3зЗ][\s]*$/u, reply: ':3' },
];

const REPLY_TO_TRIGGER = true;
const OWNER_ID = 653838366;
// PATH_SECRET is read from the Worker secret (env.PATH_SECRET), never hardcoded.
// Set it with: wrangler secret put PATH_SECRET

// ── Sleep mode ───────────────────────────────────────────────────────────────
const TZ = 'Asia/Bishkek';                  // UTC+6
const SLEEP_START = 0;                       // 00:00 inclusive
const SLEEP_END = 8;                         // 08:00 exclusive
const NIGHT_COOLDOWN_SECONDS = 8 * 3600;     // one away note per chat per night
const AWAY_MESSAGE =
  '😴 сейчас у меня ночь - сплю, отвечу утром\n' +
  '😴 it\'s night here - i\'m asleep and will reply in the morning';

function isSleepHour() {
  const h = parseInt(new Intl.DateTimeFormat('en-US',
    { hour: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(new Date()), 10);
  return h >= SLEEP_START && h < SLEEP_END;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('ok');
    if (!env?.PATH_SECRET) return new Response('misconfigured', { status: 500 });
    if (new URL(request.url).pathname !== `/${env.PATH_SECRET}`)
      return new Response('forbidden', { status: 403 });
    // Defense in depth: verify Telegram's secret-token header when configured.
    // No-op until TG_SECRET is set, so it can't break the live webhook before setWebhook is re-run.
    if (env.TG_SECRET && request.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET)
      return new Response('forbidden', { status: 403 });

    let update;
    try { update = await request.json(); }
    catch { return new Response('bad request', { status: 400 }); }

    const action = await buildReply(update, env);
    return action ? Response.json(action) : new Response('ok');
  },
};

async function buildReply(update, env) {
  const biz = update.business_message;
  if (biz) return matchAndBuild(biz, biz.business_connection_id, env);

  const msg = update.message;
  if (msg) return matchAndBuild(msg, null, env);

  return null;
}

async function matchAndBuild(msg, businessConnId, env) {
  if (msg.from?.is_bot) return null;
  if (businessConnId && msg.from?.id === OWNER_ID) return null;

  const text = msg.text || msg.caption;
  if (!text) return null;
  // Cap pathologically long messages before the ~40-regex classifier (ReDoS/CPU guard).
  if ((text?.length ?? 0) > 512) return null;

  for (const rule of RULES) {
    let reply = null;
    if (rule.match) {
      reply = rule.match(text, msg);
    } else if (rule.pattern.test(text)) {
      reply = typeof rule.reply === 'function' ? rule.reply(msg) : rule.reply;
    }
    if (reply) return makeAction(msg, reply, businessConnId);
  }

  if (businessConnId && env?.BOT_KV && isSleepHour()) {
    const key = `away:${msg.chat.id}`;
    if (!(await env.BOT_KV.get(key))) {
      await env.BOT_KV.put(key, '1', { expirationTtl: NIGHT_COOLDOWN_SECONDS });
      return makeAction(msg, AWAY_MESSAGE, businessConnId);
    }
  }

  return null;
}

function makeAction(msg, text, businessConnId) {
  const action = { method: 'sendMessage', chat_id: msg.chat.id, text };
  if (businessConnId) action.business_connection_id = businessConnId;
  if (REPLY_TO_TRIGGER) action.reply_parameters = { message_id: msg.message_id };
  return action;
}
