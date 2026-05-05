// Author: Qim & Gemini
// Blog: https://ichochy.com
// FileName: iReader:main.js (Merged Version)
// Update: 2026/05/05
// 集成了：A/S/D/Q 快捷键、自动暂停、Ctrl背诵切换、白天黑夜模式、精准高亮提醒

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
      autoPause: false, // 新功能：自动暂停
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
      autoPauseBtn: qs('#autoPauseBtn'), 
      playPauseBtn: qs('#playPauseBtn'),
      progressBar: qs('#progressBar'),
      speedBtn: qs('#speedBtn'),
      speedText: qs('#speedText'),
      bookCover: qs('#bookCover'),
      unitSelect: qs('#unitSelect'),
      bookSelects: qsa('.book-select'),
      prevUnitBtn: qs('#prevUnitBtn'),
      nextUnitBtn: qs('#nextUnitBtn'),
      toggleTranslationBtn: qs('#toggleTranslationBtn'),
      reciteModeBtn: qs('#reciteModeBtn') 
    };

    this.lyricLineEls = [];
    this.lrcCache = new Map();
    this.audioPreload = new Map();

    this.init();
  }

  async init() {
    this.injectReciteStyles(); 
    await this.loadBooks();
    await this.applyBookFromHash();
    this.bindEvents();
    this.loadPlayModePreference();
    this.updatePlayModeUI();
    this.loadTranslationPreference();
    this.updateTranslationToggle();
    this.loadRecitePreference(); 
    this.updateReciteUI();       
    await this.loadUnitFromStorage();
  }

  // ==== 1. 核心快捷键逻辑 (A/S/D/Q) ==== //
  bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

      const key = e.key.toLowerCase();
      switch(key) {
        case 'a': // 上一句
          this.jumpSentence(-1);
          break;
        case 'd': // 下一句
          this.jumpSentence(1);
          break;
        case 's': // 重听当前句
          this.jumpSentence(0);
          break;
        case 'q': // 切换自动暂停
          if (this.dom.autoPauseBtn) this.dom.autoPauseBtn.click();
          break;
        case ' ': // 空格播放/暂停
          e.preventDefault();
          if (this.dom.playPauseBtn) this.dom.playPauseBtn.click();
          break;
      }
    });
  }

  // 改进的跳转逻辑：确保变色高亮立刻生效
  jumpSentence(offset) {
    let newIndex = this.state.currentLyricIndex + offset;
    if (offset === 0) newIndex = this.state.currentLyricIndex; // S 键重播

    if (newIndex >= 0 && newIndex < this.state.currentLyrics.length) {
      const lyric = this.state.currentLyrics[newIndex];
      // 核心：调用原有的激活逻辑
      this.playLyricAtIndex(newIndex, lyric.time);
      // 手动触发高亮 UI，不用等 timeupdate
      this.updateLyricHighlightManual(newIndex);
    }
  }

  // 手动强制 UI 变色
  updateLyricHighlightManual(index) {
    this.lyricLineEls.forEach((el, i) => {
      el.classList.toggle('active', i === index);
      el.classList.toggle('pulse', i === index);
    });
    const activeLine = this.lyricLineEls[index];
    if (activeLine) {
      activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ==== 2. 自动暂停逻辑 ==== //
  checkAutoPauseLogic() {
    if (!this.state.autoPause || !this.dom.audioPlayer || this.dom.audioPlayer.paused) return;

    const currentIndex = this.state.currentLyricIndex;
    if (currentIndex === -1) return;

    const nextLyric = this.state.currentLyrics[currentIndex + 1];
    const endTime = nextLyric ? nextLyric.time : this.dom.audioPlayer.duration;

    // 到达当前句末尾，自动暂停
    if (this.dom.audioPlayer.currentTime >= endTime - 0.1) {
      this.dom.audioPlayer.pause();
      this.dom.audioPlayer.currentTime = endTime - 0.05; 
    }
  }

  // ==== 3. 恢复你原本的 Ctrl 背诵逻辑 ==== //
  bindReciteToggle() {
    if (!this.dom.reciteModeBtn) return;
    
    this.dom.reciteModeBtn.addEventListener('click', () => {
      this.toggleReciteMode();
    });

    let isCtrlCombination = false;
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Control' && event.ctrlKey) isCtrlCombination = true;
    });

    document.addEventListener('keyup', (event) => {
      if (event.key === 'Control') {
        if (!isCtrlCombination) this.toggleReciteMode();
        isCtrlCombination = false;
      }
    });
  }

  // ==== 恢复原本的 UI 渲染逻辑 ==== //

  injectReciteStyles() {
    if (document.getElementById('recite-mode-styles')) return;
    const style = document.createElement('style');
    style.id = 'recite-mode-styles';
    style.innerHTML = `
      body.recite-mode .lyric-text { display: none !important; }
      body.recite-mode .lyric-translation { display: block !important; font-size: 1.15em !important; font-weight: 600; color: inherit !important; }
      body.recite-mode .lyric-line.active .lyric-translation { color: #ff6b35 !important; }
    `;
    document.head.appendChild(style);
  }

  async loadBooks() {
    try {
      const response = await fetch('data.json');
      const data = await response.json();
      this.state.books = Array.isArray(data.books) ? data.books : [];
    } catch (error) { console.error('加载失败', error); }
  }

  async applyBookChange(bookKey) {
    const resolved = this.state.books.find(b => b.key === bookKey) || this.state.books[0];
    if (!resolved) return;
    this.state.bookKey = resolved.key;
    this.state.bookPath = resolved.bookPath;
    localStorage.setItem(BOOK_SELECTION_STORAGE_KEY, this.state.bookKey);
    this.updateBookSelects();
    await this.loadBookConfig();
    this.renderUnitList();
    this.renderUnitSelect();
  }

  async loadBookConfig() {
    const res = await fetch(`${this.state.bookPath}/book.json`);
    const data = await res.json();
    this.state.units = data.units.map((u, i) => ({
      ...u, audio: `${this.state.bookPath}/${u.filename}.mp3`, lrc: `${this.state.bookPath}/${u.filename}.lrc`
    }));
    this.dom.bookName.textContent = `《${data.bookName}》`;
    this.dom.bookLevel.textContent = data.bookLevel;
    this.dom.bookCover.src = `${this.state.bookPath}/${data.bookCover}`;
  }

  renderLyrics() {
    this.dom.lyricsDisplay.innerHTML = this.state.currentLyrics.map((l, i) => `
      <div class="lyric-line" data-index="${i}" data-time="${l.time}">
        <div class="lyric-text">${l.english}</div>
        ${l.chinese ? `<div class="lyric-translation">${l.chinese}</div>` : ''}
      </div>
    `).join('');
    this.lyricLineEls = qsa('.lyric-line', this.dom.lyricsDisplay);
  }

  playLyricAtIndex(index, time) {
    this.dom.audioPlayer.currentTime = time;
    if (this.state.playMode === 'single') {
      const next = this.state.currentLyrics[index + 1];
      this.state.singlePlayEndTime = next ? next.time : this.dom.audioPlayer.duration;
    }
    this.dom.audioPlayer.play();
  }

  updateLyricHighlight() {
    if (this.state.isProgressDragging) return;
    const time = this.dom.audioPlayer.currentTime;
    let newIdx = -1;
    for (let i = this.state.currentLyrics.length - 1; i >= 0; i--) {
      if (time >= this.state.currentLyrics[i].time) { newIdx = i; break; }
    }
    if (newIdx !== -1 && newIdx !== this.state.currentLyricIndex) {
      this.updateLyricHighlightManual(newIdx);
      this.state.currentLyricIndex = newIdx;
    }
  }

  bindEvents() {
    this.bindShortcuts();
    this.bindReciteToggle();
    
    // 自动暂停按钮绑定
    if (this.dom.autoPauseBtn) {
      this.dom.autoPauseBtn.onclick = () => {
        this.state.autoPause = !this.state.autoPause;
        this.dom.autoPauseBtn.style.backgroundColor = this.state.autoPause ? '#ff6b35' : '';
        this.dom.autoPauseBtn.style.color = this.state.autoPause ? '#fff' : '';
      };
    }

    this.dom.playPauseBtn.onclick = () => this.dom.audioPlayer.paused ? this.dom.audioPlayer.play() : this.dom.audioPlayer.pause();
    this.dom.speedBtn.onclick = () => this.cyclePlaybackSpeed();
    this.dom.playModeBtn.onclick = () => this.togglePlayMode();
    this.dom.toggleTranslationBtn.onclick = () => this.toggleTranslation();
    
    this.dom.audioPlayer.ontimeupdate = () => {
      this.updateLyricHighlight();
      this.checkAutoPauseLogic();
      this.checkSinglePlayEnd();
      this.updateProgressUI();
    };

    this.dom.audioPlayer.onplay = () => this.dom.playPauseBtn.classList.add('playing');
    this.dom.audioPlayer.onpause = () => this.dom.playPauseBtn.classList.remove('playing');
    this.dom.audioPlayer.onended = () => { if(this.state.playMode === 'continuous') this.jumpSentence(1); };

    // 课本/单元切换
    this.dom.bookSelects.forEach(s => s.onchange = (e) => location.hash = e.target.value);
    this.dom.unitSelect.onchange = (e) => this.loadUnitByIndex(parseInt(e.target.value));
    this.dom.unitList.onclick = (e) => {
      const item = e.target.closest('.unit-item');
      if (item) this.loadUnitByIndex(parseInt(item.dataset.unitIndex));
    };
    this.dom.lyricsDisplay.onclick = (e) => {
      const line = e.target.closest('.lyric-line');
      if (line) this.playLyricAtIndex(parseInt(line.dataset.index), parseFloat(line.dataset.time));
    };

    window.addEventListener('hashchange', () => this.applyBookFromHash());
  }

  // 其他辅助函数保持原样
  togglePlayMode() {
    this.state.playMode = this.state.playMode === 'single' ? 'continuous' : 'single';
    this.dom.playModeBtn.classList.toggle('continuous-mode', this.state.playMode === 'continuous');
  }
  cyclePlaybackSpeed() {
    const idx = (this.state.availableSpeeds.indexOf(this.state.playbackRate) + 1) % this.state.availableSpeeds.length;
    this.state.playbackRate = this.state.availableSpeeds[idx];
    this.dom.audioPlayer.playbackRate = this.state.playbackRate;
    this.dom.speedText.textContent = `${this.state.playbackRate}x`;
  }
  toggleTranslation() {
    const modes = ['show', 'hide', 'blur'];
    this.state.translationMode = modes[(modes.indexOf(this.state.translationMode) + 1) % modes.length];
    document.body.classList.toggle('hide-translation', this.state.translationMode === 'hide');
    document.body.classList.toggle('blur-translation', this.state.translationMode === 'blur');
    this.dom.toggleTranslationBtn.textContent = {show:'中', hide:'英', blur:'模'}[this.state.translationMode];
  }
  toggleReciteMode() {
    this.state.reciteMode = !this.state.reciteMode;
    document.body.classList.toggle('recite-mode', this.state.reciteMode);
    this.dom.reciteModeBtn.style.color = this.state.reciteMode ? '#ff6b35' : '';
    this.dom.reciteModeBtn.style.borderColor = this.state.reciteMode ? '#ff6b35' : '';
  }
  updateProgressUI() {
    const p = (this.dom.audioPlayer.currentTime / this.dom.audioPlayer.duration) * 100;
    this.dom.progressBar.style.setProperty('--progress', `${p}%`);
  }
  checkSinglePlayEnd() {
    if (this.state.playMode === 'single' && this.state.singlePlayEndTime && this.dom.audioPlayer.currentTime >= this.state.singlePlayEndTime - 0.05) {
      this.dom.audioPlayer.pause();
      this.state.singlePlayEndTime = null;
    }
  }
  async applyBookFromHash() {
    const key = location.hash.slice(1) || DEFAULT_BOOK_KEY;
    await this.applyBookChange(key);
  }
  async loadUnitFromStorage() {
    const idx = parseInt(localStorage.getItem(`${this.state.bookPath}/currentUnitIndex`)) || 0;
    await this.loadUnitByIndex(idx);
  }
  async loadUnitByIndex(idx) {
    this.state.currentUnitIndex = clamp(idx, 0, this.state.units.length - 1);
    const unit = this.state.units[this.state.currentUnitIndex];
    const res = await fetch(unit.lrc);
    this.state.currentLyrics = LRCParser.parse(await res.text());
    this.renderLyrics();
    this.dom.audioPlayer.src = unit.audio;
    qsa('.unit-item', this.dom.unitList).forEach((el, i) => el.classList.toggle('active', i === idx));
    this.dom.unitSelect.value = idx;
    this.updateNavigationButtons();
  }
  updateNavigationButtons() {
    this.dom.prevUnitBtn.disabled = this.state.currentUnitIndex <= 0;
    this.dom.nextUnitBtn.disabled = this.state.currentUnitIndex >= this.state.units.length - 1;
  }
  updateBookSelects() {
    this.dom.bookSelects.forEach(s => {
      s.innerHTML = this.state.books.map(b => `<option value="${b.key}">${b.title}</option>`).join('');
      s.value = this.state.bookKey;
    });
  }
  loadPlayModePreference() { this.state.playMode = localStorage.getItem(PLAY_MODE_STORAGE_KEY) || 'single'; }
  loadTranslationPreference() { this.state.translationMode = localStorage.getItem('translationMode') || 'show'; }
  loadRecitePreference() { this.state.reciteMode = localStorage.getItem('reciteMode') === 'true'; }
  updatePlayModeUI() { this.dom.playModeBtn.classList.toggle('continuous-mode', this.state.playMode === 'continuous'); }
  updateReciteUI() { document.body.classList.toggle('recite-mode', this.state.reciteMode); }
}

// ==== 恢复：白天黑夜模式与全局初始化 ==== //

document.addEventListener('DOMContentLoaded', () => {
  new ReadingSystem();
  initThemeToggle(); // 恢复主题切换
  initSupportModal();
});

function initThemeToggle() {
  const themeToggle = document.getElementById('themeToggle');
  if (!themeToggle) return;
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.body.classList.add('dark-theme');
  }
  themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-theme');
    localStorage.setItem('theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
  });
}

function initSupportModal() {
  const btn = qs('#supportBtn'), modal = qs('#supportModal'), close = qs('#supportCloseBtn');
  if (!btn || !modal) return;
  btn.onclick = () => modal.classList.add('open');
  close.onclick = () => modal.classList.remove('open');
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
