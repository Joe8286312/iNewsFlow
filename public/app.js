// ========== DOM元素引用 ==========
const tabs = document.getElementById('tabs');             // 分类标签容器
const feed = document.getElementById('feed');             // 新闻列表容器
const trending = document.getElementById('trending');     // 热榜容器
const searchForm = document.getElementById('searchForm'); // 搜索表单
const qInput = document.getElementById('q');              // 搜索输入框
const cardTpl = document.getElementById('cardTpl');       // 卡片模板
const userInfo = document.getElementById('userInfo');     // 用户信息区

// DOM加载后初始化的UI元素
let brandEl = null;       // 品牌标题（"今日洋闻"）
let backToTopBtn = null;  // 回到顶部按钮

// DOM加载后初始化的缓存引用
let feedEmptyEl = null;       // 新闻列表空状态提示
let trendingEmptyEl = null;   // 热榜空状态提示
let loaderEl = null;          // 加载动画
let noMoreEl = null;          // 没有更多内容提示

/**
 * 等待DOM完全加载
 * @returns {Promise<void>}
 */
function waitForDOM() {
  return new Promise((resolve) => {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      return resolve();
    }
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

/**
 * 初始化DOM元素引用（在DOM加载后调用）
 */
function initDOMRefs() {
  feedEmptyEl = document.getElementById('feedEmpty');
  trendingEmptyEl = document.getElementById('trendingEmpty');
  loaderEl = document.getElementById('loader');
  noMoreEl = document.getElementById('noMore');
  brandEl = document.getElementById('brand');
  backToTopBtn = document.getElementById('backToTop');
}

// ========== 应用状态 ==========
let currentUser = localStorage.getItem('username') || '';  // 当前登录用户

// 应用状态对象
let state = {
  category: 'news',   // 当前分类（默认综合）
  q: '',              // 搜索关键词
  page: 1,            // 当前页码
  busy: false,        // 是否正在加载数据
  eof: false          // 是否已加载完所有数据
};

/**
 * 发送JSON请求
 * @param {string} url - 请求地址
 * @param {object} opts - fetch选项
 * @returns {Promise<object>} JSON响应
 */
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/**
 * 将ISO时间格式化为相对时间（如"3小时前"）
 * @param {string} iso - ISO时间字符串
 * @returns {string} 相对时间描述
 */
function timeFromNow(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}秒前`;
  if (diff < 3600) return `${Math.floor(diff/60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff/3600)}小时前`;
  return d.toLocaleString();
}

/**
 * 渲染分类标签页
 * @param {Array} categories - 分类列表
 */
function renderTabs(categories) {
  tabs.innerHTML = '';
  categories.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (state.category === c.id ? ' active' : '');
    btn.textContent = c.name;
    btn.dataset.id = c.id;
    btn.onclick = () => switchCategory(c.id);
    tabs.appendChild(btn);
  });
}

/**
 * 创建新闻卡片DOM元素
 * @param {object} a - 文章数据对象
 * @returns {HTMLElement} 新闻卡片元素
 */
function makeCard(a) {
  const node = cardTpl.content.firstElementChild.cloneNode(true);
  
  // 设置稳定的data-id用于后续查找
  try { 
    node.setAttribute('data-id', a.id || ''); 
  } catch(e) {}
  
  // 设置封面图
  const coverEl = node.querySelector('.cover');
  if (a.cover) {
    coverEl.src = a.cover;
    coverEl.classList.remove('placeholder');
    
    // 添加图片加载错误处理
    coverEl.onerror = () => {
      console.warn('图片加载失败:', a.cover);
      coverEl.classList.add('placeholder');
      coverEl.src = ''; // 清空src避免重复请求
    };
    
    // 图片加载成功时的处理
    coverEl.onload = () => {
      console.log('图片加载成功:', a.cover);
    };
  } else {
    // 使用占位符样式
    coverEl.src = '';
    coverEl.classList.add('placeholder');
  }
  
  // 设置分类标签
  const catNode = node.querySelector('.cat');
  if (catNode) {
    catNode.textContent = (a.category || '').toUpperCase();
    // 设置分类颜色类名
    const cls = (a.category || '').toLowerCase();
    catNode.className = 'cat ' + cls;
  }
  
  // 设置标题和摘要
  node.querySelector('.title').textContent = a.title;
  node.querySelector('.summary').textContent = a.summary || '';
  node.querySelector('.time').textContent = timeFromNow(a.publishedAt);
  node.querySelector('.likes').textContent = a.likes || 0;
  
  // 点击封面或标题打开详情
  const open = () => {
    openDetail(a.id);
  };
  node.querySelector('.cover').onclick = open;
  node.querySelector('.title').onclick = open;

  // 点赞按钮点击事件
  node.querySelector('.like').onclick = async () => {
    if (!currentUser) {
      alert('请先登录！');
      return;
    }
    try {
      const r = await fetchJSON(`/api/articles/${encodeURIComponent(a.id)}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser })
      });
      node.querySelector('.likes').textContent = r.likes;
    } catch (e) {
      alert('点赞失败：' + e.message);
    }
  };
  
  // 评论按钮点击事件
  const cbtn = node.querySelector('.comment-btn');
  if (cbtn) {
    cbtn.onclick = () => {
      openDetail(a.id).then(() => {
        const ta = document.getElementById('commentText');
        if (ta) ta.focus();  // 自动聚焦到评论输入框
      }).catch(() => {});
    };
  }
  
  return node;
}

/**
 * 加载更多新闻（无限滚动）
 */
async function loadMore() {
  // 如果正在加载或已加载完所有内容，则跳过
  if (state.busy || state.eof) return;
  state.busy = true;
  
  // 显示加载动画，隐藏"没有更多"提示
  if (loaderEl) loaderEl.style.display = 'flex';
  if (noMoreEl) noMoreEl.style.display = 'none';
  
  // 调用统一的新闻API端点：传递分类、页码、搜索关键词
  try {
    const params = new URLSearchParams({ 
      category: state.category, 
      q: state.q || '', 
      page: state.page, 
      pageSize: 10 
    });
    const data = await fetchJSON(`/api/news?${params}`);
    const items = data.items || [];
    
    // 将新闻卡片添加到列表
    items.forEach(a => feed.appendChild(makeCard(a)));
    
    // 增加页码以便下次加载
    if (items.length > 0) state.page = Number(state.page) + 1;
    
    // 如果返回的数据少于10条，说明已经没有更多内容
    state.eof = items.length < 10;
  } catch (e) {
    console.error('loadMore failed', e);
    state.eof = true;
  }
  
  state.busy = false;
  if (loaderEl) loaderEl.style.display = 'none';
  if (state.eof && noMoreEl) noMoreEl.style.display = 'block';
}

/**
 * 初始化应用
 */
async function init() {
  console.log('[app] init start');
  await waitForDOM();
  initDOMRefs();
  updateUserUI();

  /**
   * 显示初始化错误提示
   * @param {string} msg - 错误消息
   */
  const showInitError = (msg) => {
    console.error('[app] init error:', msg);
    let el = document.getElementById('initError');
    if (!el) {
      el = document.createElement('div');
      el.id = 'initError';
      el.style.cssText = 'background:#fee;border:1px solid #f99;padding:10px;margin:10px;border-radius:6px;color:#900;max-width:1200px;margin-left:auto;margin-right:auto;';
      document.body.insertBefore(el, document.querySelector('.topbar')?.nextSibling || document.body.firstChild);
    }
    el.textContent = msg;
  };

  // 加载分类列表
  try {
    const cats = await fetchJSON('/api/categories');
    const categories = cats.categories;
    renderTabs(categories);
  } catch (e) {
    showInitError('加载分类失败：' + (e && e.message ? e.message : e));
    return;
  }

  // 刷新新闻列表
  try {
    await refresh();
  } catch (e) {
    showInitError('加载文章失败：' + (e && e.message ? e.message : e));
    return;
  }

  // 加载热榜数据
  try {
    // 确保feed先加载完成再渲染热榜
    await renderTrending();
  } catch (e) {
    // 热榜加载失败不阻塞应用，仅记录日志
    console.error('[app] renderTrending failed:', e);
  }

  // 绑定品牌标题点击事件 -> 跳转到综合分类
  if (brandEl) {
    brandEl.onclick = () => {
      switchCategory('news');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    // 支持键盘访问（无障碍）
    brandEl.addEventListener('keypress', (e) => { 
      if (e.key === 'Enter' || e.key === ' ') brandEl.click(); 
    });
  }

  console.log('[app] init done', { category: state.category, page: state.page });
  
  // 无限滚动监听
  window.addEventListener('scroll', () => {
    const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 200;
    if (nearBottom) loadMore();
    
    // 切换"回到顶部"按钮显示状态
    if (backToTopBtn) {
      if (window.scrollY > 400) {
        backToTopBtn.style.display = 'flex';
      } else {
        backToTopBtn.style.display = 'none';
      }
    }
  });
}

/**
 * 刷新新闻列表（清空并重新加载第一页）
 */
async function refresh() {
  feed.innerHTML = '';
  
  // 隐藏空状态提示
  if (feedEmptyEl) {
    feedEmptyEl.style.display = 'none';
  } else {
    console.warn('[app] refresh: #feedEmpty not found in DOM (cached ref is null)');
  }
  
  // 重置分页状态
  state.page = 1;
  state.eof = false;
  
  // 加载第一页数据
  await loadMore();
  
  // 如果没有任何内容，显示空状态提示
  if (!feed.children.length) {
    if (feedEmptyEl) {
      feedEmptyEl.style.display = 'block';
    } else {
      console.warn('[app] refresh: cannot show feedEmpty because cached ref is null');
    }
  }
}

/**
 * 切换分类
 * @param {string} cat - 分类ID
 */
async function switchCategory(cat) {
  state.category = cat;
  
  // 更新活动标签样式
  [...tabs.children].forEach((el) => {
    el.classList.toggle('active', el.dataset.id === cat);
  });
  
  // 切换分类时重置分页
  state.page = 1;
  state.eof = false;
  
  refresh();
}

// 搜索表单提交事件
searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  state.q = qInput.value.trim();
  refresh();
});

// ========== 用户认证相关 ==========

/**
 * 更新用户信息UI
 */
function updateUserUI() {
  userInfo.innerHTML = currentUser
    ? `👤 ${currentUser} <button id="logoutBtn">退出</button>`
    : `<button id="loginBtn">登录</button> / <button id="regBtn">注册</button>`;

  if (currentUser) {
    // 已登录：绑定退出按钮
    document.getElementById('logoutBtn').onclick = () => {
      localStorage.removeItem('username');
      currentUser = '';
      updateUserUI();
    };
  } else {
    // 未登录：绑定登录和注册按钮
    document.getElementById('loginBtn').onclick = showLogin;
    document.getElementById('regBtn').onclick = showRegister;
  }
}

/**
 * 显示登录对话框
 */
async function showLogin() {
  const username = prompt('用户名：');
  const password = prompt('密码：');
  if (!username || !password) return;
  
  try {
    const r = await fetchJSON('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    localStorage.setItem('username', r.username);
    currentUser = r.username;
    alert('登录成功');
    updateUserUI();
  } catch (e) {
    alert('登录失败');
  }
}

/**
 * 显示注册对话框
 */
async function showRegister() {
  const username = prompt('注册用户名：');
  const password = prompt('密码：');
  if (!username || !password) return;
  
  try {
    await fetchJSON('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    alert('注册成功，请登录');
  } catch (e) {
    alert('注册失败');
  }
}

// ========== 热榜渲染 ==========

/**
 * 渲染热榜列表
 */
async function renderTrending() {
  /**
   * 等待feed中至少有一篇文章（避免在feed加载前显示热榜）
   * @param {number} timeoutMs - 超时时间（毫秒）
   * @returns {Promise<boolean>} 是否成功等到内容
   */
  const waitForFeedItem = (timeoutMs = 3000) => new Promise((resolve) => {
    const interval = 150;
    const max = Math.ceil(timeoutMs / interval);
    let i = 0;
    const t = setInterval(() => {
      if (feed.children && feed.children.length > 0) {
        clearInterval(t);
        resolve(true);
        return;
      }
      i++;
      if (i >= max) {
        clearInterval(t);
        resolve(false);
      }
    }, interval);
  });

  // 等待feed加载完成
  const ready = await waitForFeedItem(3000);
  if (!ready) {
    console.log('[app] renderTrending skipped: feed empty after wait');
    return;
  }

  try {
    const { items } = await fetchJSON('/api/trending');
    trending.innerHTML = '';
    if (trendingEmptyEl) trendingEmptyEl.style.display = 'none';
    
    // 如果没有热榜数据，显示空状态
    if (!items || !items.length) {
      if (trendingEmptyEl) trendingEmptyEl.style.display = 'block';
      return;
    }
    
    // 渲染每个热榜项
    items.forEach(a => {
      const li = document.createElement('li');
      li.className = 'trend-item';
      
      // 标题链接
      const title = document.createElement('a');
      title.href = '#';
      title.className = 'trend-link';
      title.textContent = a.title;
      title.dataset.id = a.id;
      title.onclick = (e) => { 
        e.preventDefault(); 
        if (a.url) window.open(a.url, '_blank'); 
      };

      // 操作按钮区
      const actions = document.createElement('div');
      actions.className = 'trend-actions';

      // 点赞按钮
      const likeBtn = document.createElement('button');
      likeBtn.className = 'trend-like';
      likeBtn.innerHTML = `❤ <span class="trend-likes">${a.likes || 0}</span>`;
      likeBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (!currentUser) {
          alert('请先登录！');
          return;
        }
        
        try {
          const r = await fetchJSON(`/api/articles/${encodeURIComponent(a.id)}/like`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser })
          });
          likeBtn.querySelector('.trend-likes').textContent = r.likes;
          likeBtn.classList.toggle('liked', !!r.liked);
        } catch (err) {
          alert('点赞失败：' + (err.message || err));
        }
      };

      actions.appendChild(likeBtn);
      li.appendChild(title);
      li.appendChild(actions);
      trending.appendChild(li);
    });
  } catch (e) {
    console.error('renderTrending failed', e);
  }
}

// ========== 文章详情模态框 ==========

/**
 * 打开文章详情模态框
 * @param {string} id - 文章ID
 */
async function openDetail(id) {
  // 获取模态框元素
  const modal = document.getElementById('articleModal');
  const modalCover = document.getElementById('modalCover');
  const modalTitle = document.getElementById('modalTitle');
  const modalMeta = document.getElementById('modalMeta');
  const modalSummary = document.getElementById('modalSummary');
  const openOriginal = document.getElementById('openOriginal');
  const commentList = document.getElementById('commentList');
  const commentText = document.getElementById('commentText');
  const submitComment = document.getElementById('submitComment');

  try {
    // 获取文章详情
    const a = await fetchJSON(`/api/articles/${encodeURIComponent(id)}`);
    modalCover.src = a.cover || '';
    
    // 模态框点赞按钮
    let modalLike = document.getElementById('modalLike');
    if (!modalLike) {
      modalLike = document.createElement('button');
      modalLike.id = 'modalLike';
      modalLike.className = 'btn';
      modalLike.textContent = `❤ ${a.likes || 0}`;
      const actionsWrap = document.querySelector('.modal-actions');
      if (actionsWrap) actionsWrap.insertBefore(modalLike, actionsWrap.firstChild || null);
    } else {
      modalLike.textContent = `❤ ${a.likes || 0}`;
    }
    
    // 点赞按钮点击事件
    modalLike.onclick = async () => {
      if (!currentUser) { 
        alert('请先登录'); 
        return; 
      }
      
      try {
        modalLike.disabled = true;
        const r = await fetchJSON(`/api/articles/${encodeURIComponent(id)}/like`, {
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ username: currentUser })
        });
        modalLike.textContent = `❤ ${r.likes}`;
        
        // 同步更新列表中对应卡片的点赞数
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) {
          const likesEl = card.querySelector('.likes');
          if (likesEl) likesEl.textContent = r.likes;
        }
      } catch (e) {
        alert('点赞失败：' + (e.message || e));
      } finally { 
        modalLike.disabled = false; 
      }
    };
    
    // 设置文章信息
    modalTitle.textContent = a.title || '';
    modalMeta.textContent = `${a.source || ''} · ${a.publishedAt ? new Date(a.publishedAt).toLocaleString() : ''} · ${a.likes || 0}❤`;
    modalSummary.textContent = a.summary || '';
    
    // 设置原文链接
    if (a.url) {
      openOriginal.href = a.url;
      openOriginal.style.display = 'inline-block';
    } else {
      openOriginal.style.display = 'none';
    }

    // 加载评论列表
    commentList.innerHTML = '<li class="comment-item">加载中...</li>';
    try {
      // 传递用户名以标记该用户点赞过的评论
      const cc = await fetchJSON(`/api/articles/${encodeURIComponent(id)}/comments${currentUser ? `?username=${encodeURIComponent(currentUser)}` : ''}`);
      const items = cc.items || [];
      
      if (!items.length) {
        commentList.innerHTML = '<li class="comment-item">暂无评论</li>';
      } else {
        commentList.innerHTML = items.map(it => {
          const likedCls = it.liked ? 'comment-liked' : '';
          const likes = it.likes || 0;
          return `
            <li class="comment-item" data-comment-id="${it.id}">
              <div class="comment-meta">${it.username} · ${new Date(it.createdAt).toLocaleString()}</div>
              <div class="comment-text">${escapeHtml(it.text)}</div>
              <div class="comment-row" style="margin-top:8px;display:flex;align-items:center;gap:8px">
                <button class="btn comment-like ${likedCls}" data-comment-id="${it.id}">❤ <span class="c-likes">${likes}</span></button>
              </div>
            </li>`;
        }).join('');
      }
    } catch (e) {
      commentList.innerHTML = '<li class="comment-item">加载评论失败</li>';
    }

    // 模态框中的登录提示
    const modalAuth = document.getElementById('modalAuth');
    if (modalAuth) {
      if (!currentUser) {
        modalAuth.style.display = 'inline-block';
        modalAuth.innerHTML = `<button id="modalLoginBtn" class="btn">登录以发表评论</button>`;
        document.getElementById('modalLoginBtn').onclick = async () => {
          await showLogin();
          // 登录后更新UI
          if (currentUser) {
            modalAuth.style.display = 'none';
          }
        };
      } else {
        modalAuth.style.display = 'none';
      }
    }

    // 确保模态框打开时评论列滚动到顶部
    setTimeout(() => {
      const commentsCol = document.querySelector('.comments-column');
      if (commentsCol) {
        commentsCol.scrollTop = 0;
      }
    }, 120);

    // 输入框获得焦点时，滚动到底部显示输入区域
    commentText.onfocus = () => {
      setTimeout(() => {
        const commentsCol = document.querySelector('.comments-column');
        if (commentsCol) {
          // 滚动到底部以显示输入框和提交按钮
          commentsCol.scrollTop = commentsCol.scrollHeight;
        }
      }, 100);
    };

    // 提交评论按钮事件
    submitComment.onclick = async () => {
      if (!currentUser) { 
        alert('请先登录'); 
        return; 
      }
      
      const txt = commentText.value.trim();
      if (!txt) { 
        alert('评论不能为空'); 
        return; 
      }
      if (txt.length > 300) { 
        alert('评论不能超过 300 字'); 
        return; 
      }
      
      try {
        submitComment.disabled = true;
        submitComment.textContent = '提交中...';
        const r = await fetchJSON(`/api/articles/${encodeURIComponent(id)}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser, text: txt })
        });
        
        // 将新评论添加到列表
        const it = r.comment;
        const node = document.createElement('li');
        node.className = 'comment-item';
        node.setAttribute('data-comment-id', it.id);
        node.innerHTML = `
          <div class="comment-meta">${it.username} · ${new Date(it.createdAt).toLocaleString()}</div>
          <div class="comment-text">${escapeHtml(it.text)}</div>
          <div class="comment-row" style="margin-top:8px;display:flex;align-items:center;gap:8px">
            <button class="btn comment-like" data-comment-id="${it.id}">❤ <span class="c-likes">0</span></button>
          </div>`;
        
        // 如果列表中只有"暂无评论"提示，先清空
        if (commentList.querySelector('.comment-item') && 
            commentList.children.length === 1 && 
            commentList.children[0].textContent === '暂无评论') {
          commentList.innerHTML = '';
        }
        
        // 插入到列表顶部（最新评论在上）
        commentList.insertBefore(node, commentList.firstChild);
        commentText.value = '';
        
        // 为新添加的评论绑定点赞事件
        const newLikeBtn = node.querySelector('.comment-like');
        if (newLikeBtn) newLikeBtn.onclick = commentLikeHandler(id);
      } catch (e) {
        alert('发表评论失败：' + (e.message || e));
      } finally {
        submitComment.disabled = false;
        submitComment.textContent = '发表评论';
      }
    };

    // 为现有评论绑定点赞事件
    const likeBtns = commentList.querySelectorAll('.comment-like');
    likeBtns.forEach(btn => { 
      btn.onclick = commentLikeHandler(id); 
    });

    // 显示模态框
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

  } catch (e) {
    alert('打开文章失败：' + (e.message || e));
  }
}

/**
 * 关闭文章详情模态框
 */
function closeModal() {
  const modal = document.getElementById('articleModal');
  if (!modal) return;
  
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  
  // 移除固定类（如果有）
  const ca = document.querySelector('.comment-actions');
  if (ca) ca.classList.remove('comment-fixed');
}

/**
 * HTML字符转义（防止XSS）
 * @param {string} s - 待转义的字符串
 * @returns {string} 转义后的字符串
 */
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"]/g, (c) => ({ 
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;' 
  }[c] || c));
}

/**
 * 创建评论点赞事件处理器
 * @param {string} articleId - 文章ID
 * @returns {Function} 点击事件处理函数
 */
function commentLikeHandler(articleId) {
  return async function(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const commentId = btn.dataset.commentId;
    
    if (!currentUser) { 
      alert('请先登录'); 
      return; 
    }
    
    try {
      btn.disabled = true;
      const r = await fetchJSON(
        `/api/articles/${encodeURIComponent(articleId)}/comments/${encodeURIComponent(commentId)}/like`, 
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser })
        }
      );
      
      const likesSpan = btn.querySelector('.c-likes');
      if (likesSpan) likesSpan.textContent = r.likes;
      btn.classList.toggle('comment-liked', !!r.liked);
    } catch (err) {
      alert('操作失败：' + (err.message || err));
    } finally {
      btn.disabled = false;
    }
  };
}

// ========== 模态框事件绑定 ==========

// 等待DOM加载后绑定模态框事件监听器
waitForDOM().then(() => {
  const modal = document.getElementById('articleModal');
  if (!modal) return;
  
  const closeBtn = document.getElementById('modalClose');
  const backdrop = modal.querySelector('.modal-backdrop');
  
  // 关闭按钮点击事件
  closeBtn.onclick = closeModal;
  
  // 点击背景遮罩关闭
  backdrop.onclick = closeModal;
  
  // ESC键关闭模态框
  document.addEventListener('keydown', (e) => { 
    if (e.key === 'Escape') closeModal(); 
  });
});

// ========== 应用启动 ==========

// 启动应用
init().catch(err => {
  console.error(err);
  alert('初始化失败');
});

// 回到顶部按钮事件绑定
waitForDOM().then(() => {
  const b = document.getElementById('backToTop');
  if (b) {
    b.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// ========== 调试工具 ==========

// 将一些辅助函数暴露到浏览器控制台，方便调试
try {
  window.__app = {
    state,         // 应用状态
    refresh,       // 刷新列表
    switchCategory,// 切换分类
    loadMore,      // 加载更多
  };
  console.log('[app] debug helpers attached: window.__app');
} catch(e) {
  // 在非浏览器环境（如Node.js）中忽略错误
}


