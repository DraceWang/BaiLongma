import { apiUrl } from './api-client.js';

let personCardActive = false;
let currentCard = null;
let imageLookupToken = 0;
let revealTimer = null;
let animationTimer = null;

const PERSON_CARD_REVEAL_DELAY_MS = 1000;
const PERSON_CARD_LEAVE_MS = 420;
const PERSON_CARD_ENTER_MS = 520;

const $ = (id) => document.getElementById(id);

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，、;；\n]/).map(v => v.trim()).filter(Boolean);
  return [];
}

function uniqueList(items = []) {
  return [...new Set(items.map(v => String(v || '').trim()).filter(Boolean))];
}

function cleanLine(value = '') {
  return String(value || '')
    .replace(/^[\s>*\-•·]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstMatch(text = '', patterns = []) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanLine(match[1]);
  }
  return '';
}

function splitKnownFor(value = '') {
  const text = String(value || '').trim();
  const bracketWorks = [...text.matchAll(/《([^》]{1,40})》/g)].map(match => match[1]);
  const plain = text
    .replace(/《([^》]+)》/g, '$1')
    .replace(/(?:等|等等|以及|还有|还参加过|参加过).*$/g, '')
    .split(/[,，、;；/]/)
    .map(cleanLine)
    .filter(item => item && item.length <= 40);
  return uniqueList([...bracketWorks, ...plain]).slice(0, 8);
}

function inferTags(title = '', summary = '') {
  const text = `${title} ${summary}`;
  const tags = [];
  for (const tag of ['企业家', '慈善家', '歌手', '演员', '导演', '音乐人', '舞者', '制片人', '主持人', '作家']) {
    if (text.includes(tag)) tags.push(tag);
  }
  if (/阿里巴巴|淘宝|支付宝|互联网|电商/.test(text)) tags.push('互联网');
  if (/华语|流行|音乐|演唱/.test(text)) tags.push('华语音乐');
  return uniqueList(tags).slice(0, 6);
}

function inferTitle(summary = '') {
  const text = String(summary || '');
  if (/阿里巴巴.*创始人|创办.*阿里巴巴/.test(text)) return '企业家 / 阿里巴巴集团创始人';
  if (/创始人|创办/.test(text) && /企业|公司|集团|淘宝|支付宝/.test(text)) return '企业家 / 创始人';
  if (/华语|流行|演唱|歌曲|音乐/.test(text) && /歌手|唱作|创作/.test(text)) return '歌手 / 音乐人';
  if (/演员|出演|电影|电视剧/.test(text)) return '演员';
  return '';
}

function formatUpdatedAt(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function initials(name = '') {
  const compact = String(name || '').trim();
  if (!compact) return '人';
  const chars = [...compact.replace(/\s+/g, '')];
  return chars.slice(0, Math.min(2, chars.length)).join('');
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setHeroImage(src = '', name = '') {
  const hero = $('pc-hero');
  const heroImg = $('pc-hero-img');
  const fallback = $('pc-hero-fallback');
  const imageUrl = String(src || '').trim();
  if (fallback) fallback.textContent = initials(name);
  if (heroImg) {
    heroImg.src = imageUrl;
    heroImg.alt = imageUrl ? name : '';
    heroImg.hidden = !imageUrl;
  }
  if (hero) hero.classList.toggle('pc-hero-has-image', !!imageUrl);
}

async function findPersonImage(name = '') {
  const query = String(name || '').trim();
  if (!query || query === '人物卡片' || query === '未知人物') return '';
  const endpoints = [
    `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const image = data?.thumbnail?.source || data?.originalimage?.source || '';
      if (image) return image;
    } catch {}
  }
  return '';
}

function scheduleHeroImageLookup(card = {}) {
  const name = String(card.name || '').trim();
  const explicitImage = String(card.image || card.avatar || '').trim();
  const token = ++imageLookupToken;
  setHeroImage(explicitImage, name);
  if (explicitImage) return;
  findPersonImage(name).then((image) => {
    if (token !== imageLookupToken || !image) return;
    if (currentCard?.name !== name) return;
    currentCard = { ...currentCard, image, avatar: currentCard?.avatar || image };
    setHeroImage(image, name);
    reportPersonCardState(personCardActive, 'image_lookup', currentCard);
  });
}

function renderPersonCard(card = {}) {
  currentCard = card;
  const name = String(card.name || '未知人物').trim();
  setText('pc-name', name);
  setText('pc-title', card.title || '人物卡片');
  setText('pc-summary', card.summary || '暂无简介。');
  setText('pc-source', `source: ${card.source || 'person-card'}`);
  setText('pc-updated', formatUpdatedAt(card.updatedAt));
  scheduleHeroImageLookup(card);

  const knownList = $('pc-known-list');
  if (knownList) {
    const knownFor = normalizeList(card.knownFor);
    knownList.innerHTML = '';
    if (!knownFor.length) {
      const li = document.createElement('li');
      li.textContent = '暂无代表作品或识别点';
      knownList.appendChild(li);
    } else {
      for (const item of knownFor.slice(0, 6)) {
        const li = document.createElement('li');
        li.textContent = item;
        knownList.appendChild(li);
      }
    }
  }

  const tagsEl = $('pc-tags');
  if (tagsEl) {
    tagsEl.innerHTML = '';
    const tags = normalizeList(card.tags);
    for (const tag of tags.slice(0, 8)) {
      const span = document.createElement('span');
      span.className = 'pc-tag';
      span.textContent = tag;
      tagsEl.appendChild(span);
    }
  }
}

function parseAssistantPersonInfo(text = '', card = currentCard) {
  const name = String(card?.name || '').trim();
  const content = String(text || '').trim();
  if (!name || !content || !content.includes(name)) return null;
  const safeName = escapeRegExp(name);

  const compact = content.replace(/\n+/g, '\n');
  const title = firstMatch(compact, [
    /身份[：:]\s*([^\n]+)/,
    new RegExp(`${safeName}[，,\\s]*(?:\\d{4}年生[，,\\s]*)?(?:是|就是)([^。；;\\n]+)`),
  ]);
  const summary = firstMatch(compact, [
    /简介[：:]\s*([^\n]+)/,
    new RegExp(`(${safeName}[^。！？!?\\n]{8,140}[。！？!?]?)`),
  ]);
  const knownText = firstMatch(compact, [
    /(?:代表事件|代表作品|代表作|识别点)[：:]\s*([^\n]+)/,
    /代表(?:作|作品)?(?:包括|有)?[：:]?\s*([^。；;\n]+)/,
    /创办了?\s*([^。；;\n]+)/,
  ]);
  const knownFor = splitKnownFor(knownText);
  const inferredTitle = title || inferTitle(summary);
  const tags = inferTags(inferredTitle, summary);

  if (!title && !summary && !knownFor.length && !tags.length) return null;

  return {
    ...card,
    name,
    title: inferredTitle || card.title,
    summary: summary || card.summary,
    knownFor: uniqueList([...normalizeList(card.knownFor), ...knownFor]),
    tags: uniqueList([...normalizeList(card.tags).filter(tag => tag !== '待补充' && tag !== 'standby'), ...tags]),
    source: 'assistant_reply',
    updatedAt: new Date().toISOString(),
  };
}

export function updatePersonCardFromAssistantText(text = '') {
  if (!personCardActive || !currentCard?.name) return false;
  const nextCard = parseAssistantPersonInfo(text, currentCard);
  if (!nextCard) return false;
  renderPersonCard(nextCard);
  reportPersonCardState(true, 'assistant_reply', nextCard);
  return true;
}

function reportPersonCardState(visible, source = 'brain-ui', card = currentCard) {
  fetch(apiUrl('/person-card-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, source, card }),
  }).catch(() => {});
}

export function setPersonCardMode(visible, { source = 'brain-ui', card = null } = {}) {
  const nextVisible = !!visible;
  if (card) renderPersonCard(card);
  const panel = $('person-card-panel');
  if (revealTimer) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  if (animationTimer) {
    clearTimeout(animationTimer);
    animationTimer = null;
  }

  if (!nextVisible) {
    personCardActive = false;
    if (panel && panel.classList.contains('pc-visible')) {
      panel.classList.remove('pc-entering');
      panel.classList.add('pc-leaving');
      animationTimer = setTimeout(() => {
        animationTimer = null;
        document.body.classList.remove('person-card-mode');
        panel.classList.remove('pc-visible', 'pc-leaving');
      }, PERSON_CARD_LEAVE_MS);
    } else {
      document.body.classList.remove('person-card-mode');
      if (panel) panel.classList.remove('pc-visible', 'pc-entering', 'pc-leaving');
    }
    reportPersonCardState(false, source, currentCard);
    return;
  }

  revealTimer = setTimeout(() => {
    revealTimer = null;
    personCardActive = true;
    document.body.classList.add('person-card-mode');
    if (panel) {
      panel.classList.remove('pc-leaving');
      panel.classList.add('pc-visible', 'pc-entering');
      animationTimer = setTimeout(() => {
        animationTimer = null;
        panel.classList.remove('pc-entering');
      }, PERSON_CARD_ENTER_MS);
    }
    reportPersonCardState(true, source, currentCard);
  }, PERSON_CARD_REVEAL_DELAY_MS);
}

export function togglePersonCard(source = 'brain-ui') {
  setPersonCardMode(!personCardActive, { source });
}

export async function showPersonCardByName(name, { source = 'brain-ui' } = {}) {
  const query = String(name || '').trim();
  if (!query) return;
  try {
    const res = await fetch(apiUrl(`/person-card?name=${encodeURIComponent(query)}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setPersonCardMode(true, { source, card: data.card || { name: query } });
  } catch (err) {
    console.warn('[PersonCard] 人物卡片加载失败:', err.message);
    setPersonCardMode(true, {
      source,
      card: {
        name: query,
        title: '人物卡片',
        summary: '暂时没有资料。可以让 Longma 补充这个人的身份和代表作品。',
        knownFor: [],
        tags: ['待补充'],
        source: 'fallback',
        updatedAt: new Date().toISOString(),
      },
    });
  }
}

export function extractPersonCardQuery(text = '') {
  const message = String(text || '').trim();
  if (!message) return '';
  const patterns = [
    /(?:我)?(?:不认识|不了解|不知道|没听过)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·.\-\s]{1,24})/u,
    /([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·.\-\s]{1,24})\s*(?:是谁|是什么人|哪位|干嘛的|为什么火|为什么红)/u,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    const raw = match?.[1] || '';
    const cleaned = raw
      .replace(/^(你知道|知道|请问|帮我看看|帮我查查|那个|这个|这位|那位|明星|叫|是|叫做|名叫)\s*/, '')
      .replace(/^(你知道|知道|请问|那个|这个|这位|那位)\s*/, '')
      .replace(/[，。！？?!.、：:；;].*$/, '')
      .trim();
    if (cleaned) return cleaned;
  }
  return '';
}

export function initPersonCard() {
  renderPersonCard(currentCard || {
    name: '人物卡片',
    title: '待命',
    summary: '当你不认识某位公众人物时，Longma 会在这里弹出一张简短人物卡片。',
    knownFor: [],
    tags: ['standby'],
    source: 'standby',
  });

  const exitBtn = $('pc-exit-btn');
  if (exitBtn) exitBtn.addEventListener('click', () => setPersonCardMode(false, { source: 'brain-ui' }));
}
