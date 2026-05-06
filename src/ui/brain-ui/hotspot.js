// 热点模式主逻辑 — 切换、模拟数据、时钟、实时流

import { HotspotEarth } from './hotspot-earth.js';

// ── 模拟数据 ──────────────────────────────────────────────────────────────────

const MOCK_DOUYIN = [
  { rank:1,  text:'四川宜宾地震现场实拍',   heat:'1892万', trend:'up',   isNew:false },
  { rank:2,  text:'奥运圣火传递沿线盛况',   heat:'1456万', trend:'up',   isNew:false },
  { rank:3,  text:'AI换脸技术有多道真',     heat:'1234万', trend:'down', isNew:false },
  { rank:4,  text:'暴雨中的暖心一幕',       heat:'988万',  trend:'up',   isNew:false },
  { rank:5,  text:'特斯拉召回主发声',       heat:'876万',  trend:'same', isNew:false },
  { rank:6,  text:'夏日必去避暑目的地',     heat:'754万',  trend:'up',   isNew:false },
  { rank:7,  text:'神舟十八号发射回顾',     heat:'698万',  trend:'up',   isNew:true  },
  { rank:8,  text:'00后整顿职场名场面',     heat:'612万',  trend:'down', isNew:false },
  { rank:9,  text:'宠物猫日常搞笑瞬间',    heat:'534万',  trend:'same', isNew:false },
  { rank:10, text:'国漫新番口碑炸裂',      heat:'476万',  trend:'up',   isNew:false },
];

const MOCK_XHS = [
  { rank:1,  text:'宜宾地震应急避险指南',  heat:'89万',  trend:'up',   isNew:false },
  { rank:2,  text:'夏天防晒实测报告',      heat:'76万',  trend:'up',   isNew:false },
  { rank:3,  text:'巴黎奥运开幕式穿搭',    heat:'68万',  trend:'up',   isNew:true  },
  { rank:4,  text:'台风来袭家庭备灾清单',  heat:'61万',  trend:'up',   isNew:false },
  { rank:5,  text:'平价好用护肤品合集',    heat:'57万',  trend:'same', isNew:false },
  { rank:6,  text:'神舟十八太空生活vlog',  heat:'52万',  trend:'up',   isNew:true  },
  { rank:7,  text:'毕业旅行最美目的地',    heat:'48万',  trend:'down', isNew:false },
  { rank:8,  text:'AI工具实测大合集',      heat:'44万',  trend:'same', isNew:false },
  { rank:9,  text:'下半年读书计划分享',    heat:'39万',  trend:'up',   isNew:false },
  { rank:10, text:'国产手机拍照横评',      heat:'35万',  trend:'down', isNew:false },
];

const MOCK_WECHAT = [
  { rank:1,  text:'四川宜宾发生6.0级地震',          heat:'深度解析', trend:'up',   isNew:false },
  { rank:2,  text:'特斯拉召回事件深度解析',         heat:'深度解析', trend:'down', isNew:false },
  { rank:3,  text:'宏观经济半年报告解读',           heat:'独家',    trend:'up',   isNew:false },
  { rank:4,  text:'巴黎奥运看点前瞻',              heat:'特稿',    trend:'up',   isNew:false },
  { rank:5,  text:'台风来袭如何科学防范',           heat:'科普',    trend:'up',   isNew:false },
  { rank:6,  text:'华为新芯片技术全解析',           heat:'深度',    trend:'up',   isNew:true  },
  { rank:7,  text:'下半年投资机会展望',             heat:'研报',    trend:'same', isNew:false },
  { rank:8,  text:'教育改革最新政策解读',           heat:'政策',    trend:'down', isNew:false },
  { rank:9,  text:'居民消费数据趋势分析',           heat:'数据',    trend:'up',   isNew:false },
  { rank:10, text:'神舟十八任务意义',              heat:'科技',    trend:'up',   isNew:true  },
];

const MOCK_CHANNELS = [
  { rank:1,  text:'四川宜宾地震科普与避险',     heat:'876万', trend:'up',   isNew:false },
  { rank:2,  text:'奥运开幕式全程回顾',         heat:'712万', trend:'up',   isNew:false },
  { rank:3,  text:'特斯拉召回事件时间线',       heat:'598万', trend:'down', isNew:false },
  { rank:4,  text:'AI工具实测合集2024',        heat:'534万', trend:'same', isNew:false },
  { rank:5,  text:'暴雨救援现场记录',          heat:'487万', trend:'up',   isNew:false },
  { rank:6,  text:'神舟十八发射全程',          heat:'445万', trend:'up',   isNew:true  },
  { rank:7,  text:'游戏新作实机演示',          heat:'398万', trend:'down', isNew:false },
  { rank:8,  text:'考研人数再创新高',          heat:'356万', trend:'up',   isNew:false },
  { rank:9,  text:'国漫崛起之路',             heat:'312万', trend:'same', isNew:false },
  { rank:10, text:'科技巨头财报对比',          heat:'278万', trend:'down', isNew:false },
];

// 实时事件流卡片
const MOCK_FEED = [
  { time:'19:25', cat:'自然灾害', catColor:'#e05c5c', title:'四川宜宾县发生6.0级地震', desc:'震源深度10公里，暂无人员伤亡报告，救援力量已巡查到达震源周边', loc:'中国·四川', img:'' },
  { time:'19:24', cat:'科技',     catColor:'#5c9ee0', title:'神舟十八号发射任务圆满成功', desc:'载人飞船与空间站组合体成功对接，状态良好。', loc:'酒泉卫星发射中心', img:'' },
  { time:'19:23', cat:'财经',     catColor:'#c97d30', title:'特斯拉全球召回超110万辆汽车', desc:'涉及安全带及软件问题，特斯拉免费修复。', loc:'全球', img:'' },
  { time:'19:22', cat:'体育',     catColor:'#4eaa6e', title:'巴黎奥运圣火抵达马赛港', desc:'开幕式倒计时启动，法国全境传递沿线盛况空前，7月26日开幕。', loc:'法国·马赛', img:'' },
  { time:'19:21', cat:'社会',     catColor:'#9b6bc4', title:'台风"玛莉亚"逼近东南沿海', desc:'预计26日凌晨在浙江登陆，多地发布台风橙色预警，船只回港避险。', loc:'中国·东南沿海', img:'' },
  { time:'19:19', cat:'科技',     catColor:'#5c9ee0', title:'华为发布全新 AI 芯片', desc:'性能较上代提升60%，将首批搭载于旗舰产品线，引发行业广泛关注。', loc:'中国·深圳', img:'' },
  { time:'19:18', cat:'政策',     catColor:'#6bbfbf', title:'欧盟正式通过 AI 监管法案', desc:'《人工智能法案》生效，将对高风险AI系统实施强制合规审查。', loc:'比利时·布鲁塞尔', img:'' },
  { time:'19:17', cat:'旅游',     catColor:'#c4a030', title:'多地景区迎来客流高峰', desc:'暑期旅游热度持续攀升，热门景区单日接待游客超历史纪录。', loc:'中国多地', img:'' },
];

// 底部跑马灯文字
const TICKER_ITEMS = [
  { time:'19:20', text:'上海发布高温红色预警，气温预计突破40℃' },
  { time:'19:19', text:'全球芯片市场半年年报告发布，亚太份额持续上升' },
  { time:'19:18', text:'欧盟通过 AI 法案，将对高风险系统强制审查' },
  { time:'19:17', text:'多地景区迎来客流高峰，暑运旅游市场表现亮眼' },
  { time:'19:16', text:'国际油价小幅上涨，布伦特原油突破85美元/桶' },
  { time:'19:15', text:'A股午后强势拉升，沪指收涨1.24%，科技板块领涨' },
  { time:'19:14', text:'北京时间明日凌晨2点：欧洲杯决赛，全球直播' },
  { time:'19:13', text:'研究显示：今夏北半球平均气温创历史新高' },
];

// ── 状态 ──────────────────────────────────────────────────────────────────────

let hotspotActive = false;
let earth         = null;
let clockTimer    = null;
let feedAutoTimer = null;
let feedIndex     = 0;

// ── DOM 工具 ──────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// ── 热榜列表渲染 ──────────────────────────────────────────────────────────────

const TREND_ICONS = { up: '↑', down: '↓', same: '—' };
const TREND_CLASSES = { up: 'hs-trend-up', down: 'hs-trend-dn', same: 'hs-trend-same' };

function renderList(listId, items, style = 'heat') {
  const ul = $(listId);
  if (!ul) return;
  ul.innerHTML = items.map(({ rank, text, heat, trend, isNew }) => {
    const rankCls = rank <= 3 ? `hs-rank-top${rank}` : '';
    const trendIcon = TREND_ICONS[trend] || '';
    const trendCls  = TREND_CLASSES[trend] || '';
    const newBadge  = isNew ? '<span class="hs-new-badge">新</span>' : '';
    const heatLabel = style === 'heat'
      ? `<span class="hs-heat">${heat}</span>`
      : `<span class="hs-label-badge">${heat}</span>`;
    return `<li class="hs-item">
      <span class="hs-rank ${rankCls}">${rank}</span>
      <span class="hs-item-text">${text}${newBadge}</span>
      ${heatLabel}
      <span class="hs-trend ${trendCls}">${trendIcon}</span>
    </li>`;
  }).join('');
}

function renderAllLists() {
  renderList('hs-douyin-list',   MOCK_DOUYIN,   'heat');
  renderList('hs-xhs-list',      MOCK_XHS,      'heat');
  renderList('hs-wechat-list',   MOCK_WECHAT,   'label');
  renderList('hs-channels-list', MOCK_CHANNELS, 'heat');
}

// ── 实时事件流 ───────────────────────────────────────────────────────────────

const CAT_COLORS = {
  '自然灾害':'#e05c5c', '科技':'#5c9ee0', '财经':'#c97d30',
  '体育':'#4eaa6e', '社会':'#9b6bc4', '政策':'#6bbfbf', '旅游':'#c4a030',
};

function renderFeed() {
  const track = $('hs-feed-track');
  if (!track) return;
  track.innerHTML = MOCK_FEED.map((item) => {
    const color = item.catColor || CAT_COLORS[item.cat] || '#8fb6d8';
    return `<div class="hs-feed-card">
      <div class="hs-feed-card-top">
        <span class="hs-feed-time">${item.time}</span>
        <span class="hs-feed-cat" style="background:${color}22;color:${color};border-color:${color}44">${item.cat}</span>
      </div>
      <div class="hs-feed-title">${item.title}</div>
      <div class="hs-feed-desc">${item.desc}</div>
      <div class="hs-feed-loc">📍 ${item.loc}</div>
    </div>`;
  }).join('');
}

function scrollFeedTo(idx) {
  const track    = $('hs-feed-track');
  const viewport = $('hs-feed-viewport');
  if (!track || !viewport) return;
  const cards = track.querySelectorAll('.hs-feed-card');
  if (!cards.length) return;
  feedIndex = ((idx % cards.length) + cards.length) % cards.length;
  const cardW   = cards[0].offsetWidth + 12; // gap
  const maxScroll = track.scrollWidth - viewport.offsetWidth;
  const target  = Math.min(feedIndex * cardW, maxScroll);
  viewport.scrollTo({ left: target, behavior: 'smooth' });
}

function startFeedAuto() {
  if (feedAutoTimer) clearInterval(feedAutoTimer);
  feedAutoTimer = setInterval(() => {
    scrollFeedTo(feedIndex + 1);
  }, 4000);
}

function stopFeedAuto() {
  if (feedAutoTimer) clearInterval(feedAutoTimer);
  feedAutoTimer = null;
}

// ── 底部跑马灯 ───────────────────────────────────────────────────────────────

function renderTicker() {
  const el = $('hs-ticker-inner');
  if (!el) return;
  const html = TICKER_ITEMS.map(
    ({ time, text }) => `<span class="hs-ticker-item"><span class="hs-ticker-time">${time}</span>${text}</span>`
  ).join('<span class="hs-ticker-sep">●</span>');
  // 翻倍内容实现无缝
  el.innerHTML = html + '<span class="hs-ticker-sep">●</span>' + html;
}

// ── 实时时钟 ─────────────────────────────────────────────────────────────────

function updateClock() {
  const el = $('hs-clock');
  if (!el) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function startClock() {
  updateClock();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(updateClock, 1000);
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

// ── 模式切换 ─────────────────────────────────────────────────────────────────

function setPanelVisible(visible) {
  hotspotActive = visible;
  document.body.classList.toggle('hotspot-mode', visible);

  const btn = document.getElementById('hotspot-btn');
  if (btn) btn.classList.toggle('active', visible);

  window.dispatchEvent(new CustomEvent('bailongma:hotspot-mode', {
    detail: { active: visible },
  }));
}

export function toggleHotspot() {
  if (hotspotActive) {
    setPanelVisible(false);
    stopClock();
    stopFeedAuto();
  } else {
    // 关闭其他媒体模式（互斥）
    if (document.body.classList.contains('video-mode'))
      document.body.classList.remove('video-mode');
    if (document.body.classList.contains('image-mode'))
      document.body.classList.remove('image-mode');
    if (document.body.classList.contains('music-mode'))
      document.body.classList.remove('music-mode');

    setPanelVisible(true);
    startClock();
    startFeedAuto();

    // 触发地球入场动画
    if (earth) {
      requestAnimationFrame(() => earth.triggerAppear());
    }
  }
}

// ── 初始化 ───────────────────────────────────────────────────────────────────

export async function initHotspot() {
  // 填充静态内容
  renderAllLists();
  renderFeed();
  renderTicker();

  // 绑定关闭按钮
  const exitBtn = $('hs-exit-btn');
  if (exitBtn) exitBtn.addEventListener('click', () => toggleHotspot());

  // 绑定实时流控制按钮
  const prevBtn = $('hs-feed-prev');
  const nextBtn = $('hs-feed-next');
  if (prevBtn) prevBtn.addEventListener('click', () => { stopFeedAuto(); scrollFeedTo(feedIndex - 1); });
  if (nextBtn) nextBtn.addEventListener('click', () => { stopFeedAuto(); scrollFeedTo(feedIndex + 1); });

  // 初始化 Three.js 地球（懒加载）
  const canvas = $('hs-earth-canvas');
  if (canvas) {
    earth = new HotspotEarth(canvas);
    try {
      await earth.init();
    } catch (err) {
      console.warn('[HotspotEarth] 初始化失败，可能是网络问题:', err);
    }
  }
}
