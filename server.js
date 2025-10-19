// ========== 导入依赖模块 ==========
import express from 'express';
import path from 'path';
import morgan from 'morgan';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs';
import crypto from 'crypto';

// ========== 基础配置 ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());           // 解析JSON请求体
app.use(morgan('dev'));            // HTTP请求日志

const PUBLIC_DIR = path.join(__dirname, 'public');
const NEWS_API_KEY = process.env.NEWS_API_KEY || '94a9a8ccb60445889de205f2c11a0f6f';  // NewsAPI密钥
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';             // 代理设置
const DATA_FILE = path.join(__dirname, 'data.json');                                   // 数据持久化文件路径

// ========== 数据存储 ==========
let db = { users: [], likesDB: {} };  // 用户数据和点赞数据库

// 内存中的文章存储和评论存储
const articleStore = {};  // 文章存储：id -> { id, title, summary, cover, content, url, source, category, publishedAt }
const commentsDB = {};    // 评论存储：id -> [{ username, text, createdAt }]

// ========== 数据持久化 ==========

// 启动时从文件读取历史数据
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    db.users = parsed.users || [];
    
    // 还原点赞数据库（将JSON数组转换为Set）
    db.likesDB = {};
    for (const [id, val] of Object.entries(parsed.likesDB || {})) {
      db.likesDB[id] = {
        count: val.count || 0,
        users: new Set(val.users || []),  // 从数组还原为Set
      };
    }
    
    // 还原持久化的文章存储和评论数据
    if (parsed.articleStore && typeof parsed.articleStore === 'object') {
      Object.assign(articleStore, parsed.articleStore);
    }
    if (parsed.commentsDB && typeof parsed.commentsDB === 'object') {
      Object.assign(commentsDB, parsed.commentsDB);
    }
    
    console.log('✅ 数据已从 data.json 加载');
  } catch (err) {
    console.error('⚠️ 加载 data.json 失败:', err);
  }
}

/**
 * 将数据保存到文件
 */
function saveDB() {
  const toSave = {
    users: db.users,
    // 将 Set 转为数组以便JSON序列化
    likesDB: Object.fromEntries(
      Object.entries(db.likesDB).map(([id, val]) => [
        id,
        { count: val.count, users: Array.from(val.users) },
      ])
    ),
    // 持久化文章元数据和评论
    articleStore,
    commentsDB,
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2));
}

// 便捷引用
const { users, likesDB } = db;

/**
 * 记录错误并返回500响应
 * @param {object} res - Express响应对象
 * @param {string} tag - 错误标签
 * @param {Error} err - 错误对象
 */
function logAnd500(res, tag, err) {
  console.error(`[${tag}]`, err && (err.stack || err.message || err));
  return res.status(500).json({ error: String(err && (err.message || err)), tag });
}

/**
 * 根据URL生成唯一ID
 * @param {string} url - 文章URL
 * @returns {string} SHA1哈希ID
 */
function makeIdFromUrl(url) {
  if (!url) return `local_${Date.now()}`;
  return crypto.createHash('sha1').update(String(url)).digest('hex');
}

// 静态文件服务
app.use(express.static(PUBLIC_DIR));

// ========== HTTP工具函数 ==========

/**
 * 发送HTTP请求并解析JSON响应
 * @param {string} url - 请求地址
 * @param {object} options - 配置选项
 * @returns {Promise<object>} JSON响应
 */
async function httpJSON(url, { timeoutMs = 10000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const options = { signal: ac.signal };
    if (PROXY_URL) {
      options.agent = new HttpsProxyAgent(PROXY_URL);  // 使用代理
    }
    const r = await fetch(url, options);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${data.message || data.error || 'Unknown error'}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ========== API路由 ==========

/**
 * 获取新闻列表
 * GET /api/news?category=tech&q=search&page=1&pageSize=10
 */
app.get("/api/news", async (req, res) => {
  // 提取查询参数（在catch块中也可用）
  const { category = "tech", q = "", page = 1, pageSize = 10 } = req.query;
  try {

    // 前端分类ID -> NewsAPI分类映射
    const categoryMap = {
      tech: "technology",
      business: "business",
      world: "general",
      sports: "sports",
    };

    // 反向映射：NewsAPI分类 -> 前端分类ID
    const reverseMap = {
      technology: "tech",
      business: "business",
      general: "world",
      sports: "sports",
    };

    let allArticles = [];

    if (category === 'news') {
      // 综合页：获取所有分类的新闻并合并
      const categoriesToFetch = ['technology', 'business', 'general', 'sports'];
      const fetchPromises = categoriesToFetch.map(async (cat) => {
        try {
          const url = `https://newsapi.org/v2/top-headlines?${new URLSearchParams({
            category: cat,
            q,
            country: 'us',
            pageSize: '25', // 每个分类获取25条以确保有足够数据
            apiKey: NEWS_API_KEY,
          }).toString()}`;
          const data = await httpJSON(url);
          return (data.articles || []).map(a => ({ ...a, apiCategory: cat }));
        } catch (err) {
          console.error(`[api/news] fetch ${cat} failed:`, err.message);
          return [];
        }
      });

      const results = await Promise.all(fetchPromises);
      allArticles = results.flat();
      
      // 按发布时间倒序排序
      allArticles.sort((a, b) => {
        const dateA = new Date(a.publishedAt || 0).getTime();
        const dateB = new Date(b.publishedAt || 0).getTime();
        return dateB - dateA;
      });

      // 去重（基于 URL）
      const seen = new Set();
      allArticles = allArticles.filter(a => {
        if (!a.url || seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      });

    } else {
      // 特定分类：只获取该分类
      const apiCategory = categoryMap[category] || 'general';
      const url = `https://newsapi.org/v2/top-headlines?${new URLSearchParams({
        category: apiCategory,
        q,
        country: 'us',
        pageSize: '50', // 获取更多以支持分页
        apiKey: NEWS_API_KEY,
      }).toString()}`;
      const data = await httpJSON(url);
      allArticles = (data.articles || []).map(a => ({ ...a, apiCategory }));
    }

    // 持久化文章并构建返回数据
    const items = allArticles.map((n, idx) => {
      const id = makeIdFromUrl(n.url) || `news_${category}_${page}_${idx}`;
      const existing = articleStore[id] || {};
      
      // 确定文章的前端分类 ID
      const frontendCat = reverseMap[n.apiCategory] || 'world';
      const existingCategories = Array.isArray(existing.categories) ? existing.categories : [];
      const newCategories = Array.from(new Set([...existingCategories, frontendCat, 'news']));

      articleStore[id] = Object.assign({}, existing, {
        id,
        title: n.title || existing.title,
        summary: n.description || existing.summary,
        cover: n.urlToImage || existing.cover,
        publishedAt: n.publishedAt || existing.publishedAt,
        url: n.url || existing.url,
        source: n.source?.name || existing.source || "",
        categories: newCategories,
        primaryCategory: frontendCat // 主分类（用于过滤）
      });

      const count = likesDB[id]?.count || 0;
      return {
        id,
        title: n.title,
        summary: n.description,
        cover: n.urlToImage,
        category: category === 'news' ? frontendCat : category, // 综合页显示文章原始分类，其他页显示请求分类
        publishedAt: n.publishedAt,
        likes: count,
        url: n.url,
        source: n.source?.name || "",
      };
    });

    // 如果是特定分类，过滤出该分类的文章
    let filteredItems = items;
    if (category !== 'news') {
      filteredItems = items.filter(item => {
        const stored = articleStore[item.id];
        return stored && stored.categories && stored.categories.includes(category);
      });
    }

    // 分页处理
    const startIdx = (Number(page) - 1) * Number(pageSize);
    const endIdx = startIdx + Number(pageSize);
    const paginatedItems = filteredItems.slice(startIdx, endIdx);

    // 保存数据（节流：仅在有新文章时保存）
    if (items.length > 0) {
      try { saveDB(); } catch(err) { console.error('saveDB failed:', err); }
    }

    res.json({ items: paginatedItems, totalResults: filteredItems.length });
  } catch (e) {
    console.error('[api/news] external fetch failed:', e && e.message);
    // Fallback: return some local mock articles so UI still works offline
    const sample = [
      {
        id: `local_${Date.now()}_1`,
        title: `示例文章 - ${category} - 1`,
        summary: `这是分类 ${category} 的示例摘要，用于离线展示。`,
        cover: '',
        category,
        publishedAt: new Date().toISOString(),
        likes: 0,
        url: ''
      },
      {
        id: `local_${Date.now()}_2`,
        title: `示例文章 - ${category} - 2`,
        summary: `第二条示例内容，帮助测试分类过滤。`,
        cover: '',
        category,
        publishedAt: new Date().toISOString(),
        likes: 0,
        url: ''
      }
    ];
    return res.json({ items: sample, totalResults: sample.length });
  }
});

/**
 * 获取文章详情
 * GET /api/articles/:id
 */
app.get('/api/articles/:id', (req, res) => {
  const { id } = req.params;
  const a = articleStore[id];
  if (!a) return res.status(404).json({ error: 'Not found' });
  const likes = likesDB[id]?.count || 0;
  return res.json({ ...a, likes });
});

/**
 * 获取文章评论列表
 * GET /api/articles/:id/comments?username=xxx
 */
app.get('/api/articles/:id/comments', (req, res) => {
  const { id } = req.params;
  const username = req.query.username;
  const items = commentsDB[id] || [];
  
  // 确保旧评论有ID和点赞数组
  let mutated = false;
  const out = items.map((it) => {
    if (!it.id) {
      it.id = crypto.createHash('sha1').update(`${id}|${it.username}|${it.createdAt}|${it.text}`).digest('hex');
      it.likedBy = it.likedBy || [];
      mutated = true;
    }
    const likes = (it.likedBy && Array.isArray(it.likedBy)) ? it.likedBy.length : (it.likes || 0);
    const liked = username && it.likedBy && it.likedBy.includes(username);
    return Object.assign({}, it, { likes, liked: !!liked });
  });
  if (mutated) {
    try { saveDB(); } catch(_) {}
  }
  res.json({ items: out });
});

/**
 * 发表评论
 * POST /api/articles/:id/comments
 */
app.post('/api/articles/:id/comments', (req, res) => {
  const { id } = req.params;
  const { username, text } = req.body;
  if (!username) return res.status(401).json({ error: '请先登录' });
  if (!text || !text.trim()) return res.status(400).json({ error: '评论不能为空' });

  const createdAt = new Date().toISOString();
  const commentId = crypto.createHash('sha1').update(`${id}|${username}|${createdAt}|${text.trim()}`).digest('hex');
  const item = { id: commentId, username, text: text.trim(), createdAt, likedBy: [], likes: 0 };
  if (!commentsDB[id]) commentsDB[id] = [];
  commentsDB[id].push(item);
  try { saveDB(); } catch(_) {}
  return res.json({ ok: true, comment: item });
});

/**
 * 评论点赞/取消点赞（切换）
 * POST /api/articles/:id/comments/:commentId/like
 */
app.post('/api/articles/:id/comments/:commentId/like', (req, res) => {
  const { id, commentId } = req.params;
  const { username } = req.body;
  if (!username) return res.status(401).json({ error: '请先登录' });
  
  const items = commentsDB[id] || [];
  const c = items.find(x => x.id === commentId);
  if (!c) return res.status(404).json({ error: 'comment not found' });
  
  // 确保 likedBy 是数组
  c.likedBy = Array.isArray(c.likedBy) ? c.likedBy : (c.likedBy ? Array.from(c.likedBy) : []);
  const idx = c.likedBy.indexOf(username);
  let liked = false;
  
  if (idx >= 0) {
    // 取消点赞
    c.likedBy.splice(idx, 1);
    liked = false;
  } else {
    // 点赞
    c.likedBy.push(username);
    liked = true;
  }
  
  c.likes = c.likedBy.length;
  try { saveDB(); } catch(_) {}
  return res.json({ likes: c.likes, liked });
});

/**
 * 获取分类列表
 * GET /api/categories
 */
app.get("/api/categories", (req, res) => {
  const categories = [
    { id: "tech", name: "科技" },
    { id: "business", name: "商业" },
    { id: "world", name: "国际" },
    { id: "sports", name: "体育" },
    { id: "news", name: "综合" }
  ];
  res.json({ categories });
});

// ========== 用户认证系统 ==========

/**
 * 用户注册
 * POST /api/register
 */
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "缺少参数" });
  if (users.find((u) => u.username === username))
    return res.status(400).json({ error: "用户名已存在" });
  users.push({ username, password });
  saveDB(); 
  res.json({ message: "注册成功" });
});

/**
 * 用户登录
 * POST /api/login
 */
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const u = users.find((x) => x.username === username && x.password === password);
  if (!u) return res.status(401).json({ error: "用户名或密码错误" });
  res.json({ message: "登录成功", username });
});

// ========== 点赞功能 ==========

/**
 * 文章点赞/取消点赞（切换）
 * POST /api/articles/:id/like
 */
app.post("/api/articles/:id/like", (req, res) => {
  const { username } = req.body;
  const { id } = req.params;
  if (!username) return res.status(401).json({ error: "请先登录" });

  if (!likesDB[id]) likesDB[id] = { count: 0, users: new Set() };

  if (likesDB[id].users.has(username)) {
    // 用户已点赞 -> 取消点赞
    likesDB[id].users.delete(username);
    likesDB[id].count--;
    saveDB(); 
    return res.json({ likes: likesDB[id].count, liked: false });
  } else {
    // 用户未点赞 -> 点赞
    likesDB[id].users.add(username);
    likesDB[id].count++;
    saveDB(); 
    return res.json({ likes: likesDB[id].count, liked: true });
  }
});

/**
 * 获取热榜（热门新闻）
 * GET /api/trending
 */
app.get('/api/trending', async (req, res) => {
  try {
    const url = `https://newsapi.org/v2/top-headlines?${new URLSearchParams({
      country: 'us',
      category: 'technology',
      pageSize: '10',
      apiKey: NEWS_API_KEY
    }).toString()}`;
    const data = await httpJSON(url);
    const items = (data.articles || []).map((n, idx) => {
      // 使用URL的SHA1哈希作为稳定的ID
      const id = makeIdFromUrl(n.url) || `trend_${idx}`;
      
      // 如果是首次看到该文章，持久化其元数据
      if (!articleStore[id]) {
        articleStore[id] = {
          id,
          title: n.title,
          summary: n.description,
          cover: n.urlToImage,
          category: 'tech',
          publishedAt: n.publishedAt,
          url: n.url,
          source: n.source?.name || '',
        };
        try { saveDB(); } catch(_) {}
      }
      
      // 从本地数据库获取点赞数
      const count = likesDB[id]?.count || 0;

      return {
        id,
        title: n.title,
        url: n.url,
        likes: count,
      };
    });
    res.json({ items });
  } catch (e) {
    console.error('[api/trending] 外部API请求失败:', e && e.message);
    // 降级方案：返回本地示例数据，确保UI正常工作
    const sample = [
      { id: 'local_tr_1', title: '本地示例热点 1', url: '', likes: 0 },
      { id: 'local_tr_2', title: '本地示例热点 2', url: '', likes: 0 },
      { id: 'local_tr_3', title: '本地示例热点 3', url: '', likes: 0 }
    ];
    return res.json({ items: sample });
  }
});

/**
 * SPA回退路由（所有未匹配的路由返回index.html）
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ========== 启动服务器 ==========

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 服务器运行在 http://localhost:${PORT}`));
