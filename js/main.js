/**
 * Author: Qim (iChochy) & Gemini Collaboration
 * FileName: iReader:main.js
 * Update: 2026/05/06
 * 功能：全量补全逻辑。修复了课本列表不显示的问题，集成了 ASDQ 快捷键、自动暂停、背诵模式。
 */

const DEFAULT_BOOK_KEY = 'NCE1';
const PLAY_MODE_STORAGE_KEY = 'playMode';
const BOOK_SELECTION_STORAGE_KEY = 'selectedBookKey';

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class ReadingSystem {
  constructor() {
    this.state = {
      books: [],
      units: [],
      bookPath: '',
      bookKey: '',
      currentLyrics: [],
      currentLyricIndex: -1,
      currentUnitIndex: -1,
      playMode: 'single',
      autoPause: false, // 自动暂停状态
      singlePlayEndTime: null,
      playbackRate: 1.0,
      translationMode: 'show',
      reciteMode: false,
      availableSpeeds: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0],
      savedPlayTime: 0,
      isProgressDragging: false
    };

    this.dom = {
      audioPlayer: qs('#audioPlayer'),
      lyricsDisplay: qs('#lyricsDisplay'),
      lyricsContainer: qs('.lyrics-container'),
      bookName: qs('#bookName'),
      bookLevel: qs('#bookLevel'),
      unitList: qs('#unitListContainer'),
      playModeBtn: qs('#playModeBtn'),
      playPauseBtn: qs('#playPauseBtn'),
      progressBar: qs('#progressBar'),
      progressFill: qs('#progressFill'),
      speedBtn: qs('#speedBtn'),
      speedText: qs('#speedText'),
      bookCover: qs('#bookCover'),
      unitSelect: qs('#unitSelect'),
      bookSelects: qsa('.book-select'),
      prevUnitBtn: qs('#prevUnitBtn'),
      nextUnitBtn: qs('#nextUnitBtn'),
      toggleTranslationBtn: qs('#toggleTranslationBtn'),
      reciteModeBtn: qs('#reciteModeBtn'),
      autoPauseBtn: qs('#autoPauseBtn')
    };

    this.lyricLineEls = [];
    this.lrcCache = new Map();
    this.audioPreload = new Map();
    this.init();
  }

  async init() {
    this.injectReciteStyles(); // 注入背诵模式样式[cite: 1]
    await this.loadBooks();
    await this.applyBookFromHash();
    this.bindEvents();
    this.loadPreferences();
    await this.loadUnitFromStorage();
  }

  // ==== 1. 快捷键逻辑 (A/S/D/Q) ====
  bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

      const key = e.key.toLowerCase();
      switch(key) {
        case 'a': this.jumpSentence(-1); break; // 上一句
        case 'd': this.jumpSentence(1); break;  // 下一句
        case 's': this.jumpSentence(0); break;  // 重播当前
        case 'q': if (this.dom.autoPauseBtn) this.dom.autoPauseBtn.click(); break;
        case ' ': 
          e.preventDefault(); 
          if (this.dom.playPauseBtn) this.dom.playPauseBtn.click(); 
          break;
      }
    });
  }

  jumpSentence(offset) {
    let targetIdx = this.state.currentLyricIndex + offset;
    if (offset === 0) targetIdx = this.state.currentLyricIndex;

    if (targetIdx >= 0 && targetIdx < this.state.currentLyrics.length) {
      const lyric = this.state.currentLyrics[targetIdx];
      this.dom.audioPlayer.currentTime = lyric.time;
      this.dom.audioPlayer.play();
      this.forceUIHighlight(targetIdx); // 按键瞬间变色
    }
  }

  forceUIHighlight(index) {
    this.lyricLineEls.forEach((el, i) => {
      el.classList.toggle('active', i === index);
      el.classList.toggle('pulse', i === index);
    });
    this.state.currentLyricIndex = index;
    const activeLine = this.lyricLineEls[index];
    if (activeLine && !this.state.isProgressDragging) {
      activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ==== 2. 自动暂停逻辑 ====
  checkAutoPauseLogic() {
    if (!this.state.autoPause || this.dom.audioPlayer.paused) return;

    const currentIndex = this.state.currentLyricIndex;
    if (currentIndex === -1) return;

    const nextLyric = this.state.currentLyrics[currentIndex + 1];
    const endTime = nextLyric ? nextLyric.time : this.dom.audioPlayer.duration;

    if (this.dom.audioPlayer.currentTime >= endTime - 0.1) {
      this.dom.audioPlayer.pause();
      this.dom.audioPlayer.currentTime = endTime - 0.05; 
    }
  }

  // ==== 3. 核心修复：课本列表渲染逻辑 ====
  updateBookSelectsUI() {
    if (!this.dom.bookSelects.length || !this.state.books.length) return;
    
    // 生成所有课本选项的 HTML
    const options = this.state.books
      .filter((book) => book && book.key && book.title && book.bookPath)
      .map((book) => `<option value="${book.key}">${book.title}</option>`)
      .join('');

    // 将内容注入到所有的 .book-select 下拉框中
    this.dom.bookSelects.forEach((select) => {
      select.innerHTML = options;
      if (this.state.bookKey) {
        select.value = this.state.bookKey;
      }
    });
  }

  async loadBooks() {
    try {
      const response = await fetch('data.json');
      const data = await response.json();
      this.state.books = Array.isArray(data.books) ? data.books : [];
      this.updateBookSelectsUI(); // 获取数据后立即更新 UI
    } catch (error) {
      console.error('加载课本数据失败:', error);
      this.renderEmptyState('未找到可用课本数据');
    }
  }

  async applyBookChange(bookKey) {
    const resolved = this.state.books.find(b => b.key === bookKey) || this.state.books[0];
    if (!resolved) return;

    this.state.bookKey = resolved.key;
    this.state.bookPath = resolved.bookPath.trim();
    localStorage.setItem(BOOK_SELECTION_STORAGE_KEY, this.state.bookKey);

    this.updateBookSelectsUI(); // 确保选中项正确[cite: 1, 2]
    await this.loadBookConfig();
    this.renderUnitList();
    this.renderUnitSelect();
  }

  async loadBookConfig() {
    try {
      const response = await fetch(`${this.state.bookPath}/book.json`);
      const data = await response.json();
      this.state.units = data.units.map((u, i) => ({
        ...u, audio: `${this.state.bookPath}/${u.filename}.mp3`, lrc: `${this.state.bookPath}/${u.filename}.lrc`
      }));
      this.dom.bookName.textContent = `《${data.bookName}》`;
      this.dom.bookCover.src = `${this.state.bookPath}/${data.bookCover}`;
    } catch (e) {
      this.renderEmptyState('课件配置加载失败');
    }
  }

  // ==== 4. 事件绑定 (保留原作者细腻交互) ====
  bindEvents() {
    this.bindShortcuts();
    this.bindReciteToggle();

    // 自动暂停按钮
    if (this.dom.autoPauseBtn) {
      this.dom.autoPauseBtn.onclick = () => {
        this.state.autoPause = !this.state.autoPause;
        this.dom.autoPauseBtn.classList.toggle('active', this.state.autoPause);
      };
    }

    this.dom.playPauseBtn.onclick = () => this.dom.audioPlayer.paused ? this.dom.audioPlayer.play() : this.dom.audioPlayer.pause();
    this.dom.speedBtn.onclick = () => this.cyclePlaybackSpeed();
    this.dom.playModeBtn.onclick = () => this.togglePlayMode();
    this.dom.toggleTranslationBtn.onclick = () => this.toggleTranslation();

    this.dom.audioPlayer.ontimeupdate = () => {
      this.updateAutoHighlight();
      this.checkAutoPauseLogic();
      this.updateProgressUI();
    };

    this.dom.audioPlayer.onplay = () => this.dom.playPauseBtn.classList.add('playing');
    this.dom.audioPlayer.onpause = () => this.dom.playPauseBtn.classList.remove('playing');
    this.dom.audioPlayer.onended = () => { if(this.state.playMode === 'continuous') this.jumpSentence(1); };

    // 列表与选择框交互
    this.dom.unitList.onclick = (e) => {
      const item = e.target.closest('.unit-item');
      if (item) this.loadUnitByIndex(parseInt(item.dataset.unitIndex));
    };

    this.dom.unitSelect.onchange = (e) => this.loadUnitByIndex(parseInt(e.target.value));

    this.dom.bookSelects.forEach(select => {
      select.onchange = (e) => {
        location.hash = e.target.value;
      };
    });

    window.addEventListener('hashchange', () => this.applyBookFromHash());
    
    // 进度条拖动逻辑 (支持移动端捕获)[cite: 1, 2]
    const seek = (clientX) => {
      if (!this.dom.audioPlayer.duration) return;
      const rect = this.dom.progressBar.getBoundingClientRect();
      const percent = clamp((clientX - rect.left) / rect.width, 0, 1);
      this.dom.audioPlayer.currentTime = percent * this.dom.audioPlayer.duration;
    };

    this.dom.progressBar.addEventListener('pointerdown', (e) => {
      this.state.isProgressDragging = true;
      this.dom.progressBar.setPointerCapture(e.pointerId);
      seek(e.clientX);
    });

    this.dom.progressBar.addEventListener('pointermove', (e) => {
      if (this.state.isProgressDragging) seek(e.clientX);
    });

    this.dom.progressBar.addEventListener('pointerup', () => this.state.isProgressDragging = false);
  }

  // ==== 5. 辅助函数补全 ====
  async loadUnitByIndex(idx) {
    this.state.currentUnitIndex = clamp(idx, 0, this.state.units.length - 1);
    localStorage.setItem(`${this.state.bookPath}/currentUnitIndex`, this.state.currentUnitIndex);
    const unit = this.state.units[this.state.currentUnitIndex];
    const res = await fetch(unit.lrc);
    this.state.currentLyrics = LRCParser.parse(await res.text());
    this.renderLyrics();
    this.dom.audioPlayer.src = unit.audio;
    this.dom.audioPlayer.load();
    this.updateActiveUnitUI(this.state.currentUnitIndex);
  }

  renderLyrics() {
    this.dom.lyricsDisplay.innerHTML = this.state.currentLyrics.map((l, i) => `
      <div class="lyric-line" data-index="${i}" data-time="${l.time}">
        <div class="lyric-text">${l.english}</div>
        <div class="lyric-translation">${l.chinese}</div>
      </div>
    `).join('');
    this.lyricLineEls = qsa('.lyric-line', this.dom.lyricsDisplay);
  }

  updateAutoHighlight() {
    if (this.state.isProgressDragging) return;
    const time = this.dom.audioPlayer.currentTime;
    let newIdx = -1;
    for (let i = this.state.currentLyrics.length - 1; i >= 0; i--) {
      if (time >= this.state.currentLyrics[i].time) { newIdx = i; break; }
    }
    if (newIdx !== -1 && newIdx !== this.state.currentLyricIndex) this.forceUIHighlight(newIdx);
  }

  updateProgressUI() {
    if (this.state.isProgressDragging) return;
    const p = (this.dom.audioPlayer.currentTime / this.dom.audioPlayer.duration) * 100;
    this.dom.progressBar.style.setProperty('--progress', `${p}%`);
  }

  bindReciteToggle() {
    let isCtrlCombination = false;
    document.addEventListener('keydown', (e) => { if (e.key !== 'Control' && e.ctrlKey) isCtrlCombination = true; });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Control' && !isCtrlCombination) this.toggleReciteMode();
      isCtrlCombination = false;
    });
    if(this.dom.reciteModeBtn) this.dom.reciteModeBtn.onclick = () => this.toggleReciteMode();
  }

  toggleReciteMode() {
    this.state.reciteMode = !this.state.reciteMode;
    document.body.classList.toggle('recite-mode', this.state.reciteMode);
    if(this.dom.reciteModeBtn) this.dom.reciteModeBtn.style.color = this.state.reciteMode ? '#ff6b35' : '';
  }

  renderUnitList() { this.dom.unitList.innerHTML = this.state.units.map((u, i) => `<div class="unit-item" data-unit-index="${i}"><h3>${u.title}</h3></div>`).join(''); }
  renderUnitSelect() { this.dom.unitSelect.innerHTML = this.state.units.map((u, i) => `<option value="${i}">${u.title}</option>`).join(''); }
  updateActiveUnitUI(idx) { qsa('.unit-item', this.dom.unitList).forEach((el, i) => el.classList.toggle('active', i === idx)); this.dom.unitSelect.value = idx; }
  injectReciteStyles() { if (!qs('#recite-styles')) { const s = document.createElement('style'); s.id = 'recite-styles'; s.innerHTML = `body.recite-mode .lyric-text { display: none !important; }`; document.head.appendChild(s); } }
  loadPreferences() { this.state.playbackRate = parseFloat(localStorage.getItem('playbackRate')) || 1.0; this.dom.audioPlayer.playbackRate = this.state.playbackRate; this.dom.speedText.textContent = `${this.state.playbackRate}x`; }
  async applyBookFromHash() { await this.applyBookChange(location.hash.slice(1) || DEFAULT_BOOK_KEY); }
  async loadUnitFromStorage() { const idx = parseInt(localStorage.getItem(`${this.state.bookPath}/currentUnitIndex`)) || 0; await this.loadUnitByIndex(idx); }
  renderEmptyState(msg) { this.dom.lyricsDisplay.innerHTML = `<p class="placeholder">${msg}</p>`; }
  togglePlayMode() { this.state.playMode = this.state.playMode === 'single' ? 'continuous' : 'single'; }
  toggleTranslation() { const modes = ['show', 'hide', 'blur']; this.state.translationMode = modes[(modes.indexOf(this.state.translationMode) + 1) % modes.length]; document.body.classList.toggle('hide-translation', this.state.translationMode === 'hide'); document.body.classList.toggle('blur-translation', this.state.translationMode === 'blur'); this.dom.toggleTranslationBtn.textContent = {show:'中', hide:'英', blur:'模'}[this.state.translationMode]; }
  cyclePlaybackSpeed() { const idx = (this.state.availableSpeeds.indexOf(this.state.playbackRate) + 1) % this.state.availableSpeeds.length; this.state.playbackRate = this.state.availableSpeeds[idx]; this.dom.audioPlayer.playbackRate = this.state.playbackRate; this.dom.speedText.textContent = `${this.state.playbackRate}x`; localStorage.setItem('playbackRate', this.state.playbackRate); }
  checkSinglePlayEnd() { if (this.state.playMode === 'single' && this.state.singlePlayEndTime && this.dom.audioPlayer.currentTime >= this.state.singlePlayEndTime - 0.05) { this.dom.audioPlayer.pause(); this.state.singlePlayEndTime = null; } }
}

// ==== 6. 全局初始化与黑夜模式 ====
function initThemeToggle() {
  const btn = qs('#themeToggle');
  if (!btn) return;
  const setDark = (isDark) => { document.body.classList.toggle('dark-theme', isDark); localStorage.setItem('theme', isDark ? 'dark' : 'light'); };
  if (localStorage.getItem('theme') === 'dark' || window.matchMedia('(prefers-color-scheme: dark)').matches) setDark(true);
  btn.onclick = () => setDark(!document.body.classList.contains('dark-theme'));
}

class LRCParser {
  static parse(lrc) {
    return lrc.split('\n').map(line => {
      const m = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.+)/);
      if (!m) return null;
      const time = parseInt(m[1])*60 + parseInt(m[2]) + parseInt(m[3])/1000 - 0.2;
      const [en, cn] = m[4].split('|').map(s => s.trim());
      return { time, english: en, chinese: cn || '' };
    }).filter(x => x).sort((a, b) => a.time - b.time);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new ReadingSystem();
  initThemeToggle();
  // 打赏弹窗逻辑
  const supportBtn = qs('#supportBtn'), modal = qs('#supportModal'), close = qs('#supportCloseBtn');
  if (supportBtn && modal) {
    supportBtn.onclick = () => modal.classList.add('open');
    close.onclick = () => modal.classList.remove('open');
  }
});
