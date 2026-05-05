// Author: Qim
// Blog: https://ichochy.com
// Email: Qim.it@icloud.com
// FileName: iReader:main.js
// Update: 2026/05/05 (Integrated ASDQ Shortcuts)
// Copyright (c) 2025.

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
      autoPause: false, // 新增：自动暂停状态
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
      autoPauseBtn: qs('#autoPauseBtn'), // 新增：自动暂停按钮
      playPauseBtn: qs('#playPauseBtn'),
      progressBar: qs('#progressBar'),
      currentTime: qs('#currentTime'),
      duration: qs('#duration'),
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

  // ==== 快捷键与自动暂停核心逻辑 ==== //

  bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      // 如果正在输入内容，不触发快捷键
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

      const key = e.key.toLowerCase();
      switch(key) {
        case 'a': // 上一句
          this.jumpToSentence(this.state.currentLyricIndex - 1);
          break;
        case 'd': // 下一句
          this.jumpToSentence(this.state.currentLyricIndex + 1);
          break;
        case 's': // 重播当前句
          this.jumpToSentence(this.state.currentLyricIndex);
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

  jumpToSentence(index) {
    if (index >= 0 && index < this.state.currentLyrics.length) {
      const lyric = this.state.currentLyrics[index];
      this.playLyricAtIndex(index, lyric.time);
    }
  }

  bindAutoPause() {
    if (!this.dom.autoPauseBtn) return;
    this.dom.autoPauseBtn.addEventListener('click', () => {
      this.state.autoPause = !this.state.autoPause;
      this.updateAutoPauseUI();
    });
  }

  updateAutoPauseUI() {
    if (!this.dom.autoPauseBtn) return;
    this.dom.autoPauseBtn.setAttribute('aria-pressed', this.state.autoPause);
    // 激活状态变色（你可以根据CSS微调）
    this.dom.autoPauseBtn.style.backgroundColor = this.state.autoPause ? 'var(--accent-color, #ff6b35)' : '';
    this.dom.autoPauseBtn.style.color = this.state.autoPause ? '#fff' : '';
  }

  checkAutoPauseLogic() {
    if (!this.state.autoPause || !this.dom.audioPlayer || this.dom.audioPlayer.paused) return;

    const currentIndex = this.state.currentLyricIndex;
    if (currentIndex === -1) return;

    const nextLyric = this.state.currentLyrics[currentIndex + 1];
    const endTime = nextLyric ? nextLyric.time : this.dom.audioPlayer.duration;

    // 如果播放时间超过了当前句子的结束时间（留0.1秒缓冲防止切音）
    if (this.dom.audioPlayer.currentTime >= endTime - 0.1) {
      this.dom.audioPlayer.pause();
      this.dom.audioPlayer.currentTime = endTime - 0.05; // 停在句尾
    }
  }

  // ==== 原有功能与修复逻辑 ==== //

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
    } catch (error) {
      this.state.books = [];
    }
  }

  resolveBookByKey(bookKey) {
    const exact = this.state.books.find(b => b.key === bookKey);
    return exact || this.state.books.find(b => b.key === DEFAULT_BOOK_KEY) || this.state.books[0];
  }

  async applyBookFromHash() {
    const key = location.hash.slice(1).trim() || localStorage.getItem(BOOK_SELECTION_STORAGE_KEY) || DEFAULT_BOOK_KEY;
    await this.applyBookChange(key);
  }

  async applyBookChange(bookKey) {
    const resolved = this.resolveBookByKey(bookKey);
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
    try {
      const response = await fetch(`${this.state.bookPath}/book.json`);
      const data = await response.json();
      this.state.units = data.units.map((u, i) => ({
        ...u, id: i + 1, audio: `${this.state.bookPath}/${u.filename}.mp3`, lrc: `${this.state.bookPath}/${u.filename}.lrc`
      }));
      this.dom.bookName.textContent = `《${data.bookName}》`;
      this.dom.bookLevel.textContent = data.bookLevel;
      this.dom.bookCover.src = `${this.state.bookPath}/${data.bookCover}`;
    } catch (e) { console.error(e); }
  }

  updateBookSelects() {
    const options = this.state.books.map(b => `<option value="${b.key}">${b.title}</option>`).join('');
    this.dom.bookSelects.forEach(s => { s.innerHTML = options; s.value = this.state.bookKey; });
  }

  renderUnitList() {
    this.dom.unitList.innerHTML = this.state.units.map((u, i) => `
      <div class="unit-item" data-unit-index="${i}" tabindex="0"><h3>${u.title}</h3></div>
    `).join('');
  }

  renderUnitSelect() {
    this.dom.unitSelect.innerHTML = this.state.units.map((u, i) => `<option value="${i}">${u.title}</option>`).join('');
  }

  async loadUnitFromStorage() {
    const idx = parseInt(localStorage.getItem(`${this.state.bookPath}/currentUnitIndex`)) || 0;
    await this.loadUnitByIndex(idx);
  }

  async loadUnitByIndex(idx) {
    this.state.currentUnitIndex = clamp(idx, 0, this.state.units.length - 1);
    localStorage.setItem(`${this.state.bookPath}/currentUnitIndex`, this.state.currentUnitIndex);
    const unit = this.state.units[this.state.currentUnitIndex];
    this.resetPlayer();
    this.updateActiveUnitUI(this.state.currentUnitIndex);
    
    const res = await fetch(unit.lrc);
    const text = await res.text();
    this.state.currentLyrics = LRCParser.parse(text);
    this.renderLyrics();
    
    this.dom.audioPlayer.src = unit.audio;
    this.dom.audioPlayer.load();
    this.updateNavigationButtons();
  }

  resetPlayer() {
    this.dom.audioPlayer.pause();
    this.state.currentLyricIndex = -1;
    this.state.singlePlayEndTime = null;
  }

  updateActiveUnitUI(idx) {
    qsa('.unit-item', this.dom.unitList).forEach((el, i) => el.classList.toggle('active', i === idx));
    this.dom.unitSelect.value = idx;
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
    this.state.currentLyricIndex = index;
    // 如果是单句模式，设置结束点
    if (this.state.playMode === 'single') {
      const next = this.state.currentLyrics[index + 1];
      this.state.singlePlayEndTime = next ? next.time : this.dom.audioPlayer.duration;
    }
    this.dom.audioPlayer.play();
  }

  updateLyricHighlight() {
    const time = this.dom.audioPlayer.currentTime;
    let newIdx = -1;
    for (let i = this.state.currentLyrics.length - 1; i >= 0; i--) {
      if (time >= this.state.currentLyrics[i].time) { newIdx = i; break; }
    }
    if (newIdx !== this.state.currentLyricIndex) {
      if (this.lyricLineEls[this.state.currentLyricIndex]) this.lyricLineEls[this.state.currentLyricIndex].classList.remove('active');
      this.state.currentLyricIndex = newIdx;
      if (this.lyricLineEls[newIdx]) {
        this.lyricLineEls[newIdx].classList.add('active');
        this.lyricLineEls[newIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  // --- 事件绑定汇总 ---
  bindEvents() {
    this.bindShortcuts(); // 快捷键
    this.bindAutoPause(); // 自动暂停按钮

    // 原有绑定
    this.dom.playPauseBtn.onclick = () => this.dom.audioPlayer.paused ? this.dom.audioPlayer.play() : this.dom.audioPlayer.pause();
    this.dom.speedBtn.onclick = () => this.cyclePlaybackSpeed();
    this.dom.playModeBtn.onclick = () => this.togglePlayMode();
    this.dom.toggleTranslationBtn.onclick = () => this.toggleTranslation();
    this.dom.reciteModeBtn.onclick = () => this.toggleReciteMode();
    this.dom.prevUnitBtn.onclick = () => this.loadUnitByIndex(this.state.currentUnitIndex - 1);
    this.dom.nextUnitBtn.onclick = () => this.loadUnitByIndex(this.state.currentUnitIndex + 1);

    this.dom.unitList.onclick = (e) => {
      const item = e.target.closest('.unit-item');
      if (item) this.loadUnitByIndex(parseInt(item.dataset.unitIndex));
    };

    this.dom.lyricsDisplay.onclick = (e) => {
      const line = e.target.closest('.lyric-line');
      if (line) this.playLyricAtIndex(parseInt(line.dataset.index), parseFloat(line.dataset.time));
    };

    this.dom.audioPlayer.ontimeupdate = () => {
      this.updateLyricHighlight();
      this.checkSinglePlayEnd(); // 原有的单句结束逻辑
      this.checkAutoPauseLogic(); // 新增的全局自动暂停逻辑
      this.updateProgressUI();
    };

    this.dom.audioPlayer.onplay = () => this.dom.playPauseBtn.classList.add('playing');
    this.dom.audioPlayer.onpause = () => this.dom.playPauseBtn.classList.remove('playing');
    this.dom.audioPlayer.onended = () => { if(this.state.playMode === 'continuous') this.jumpToSentence(this.state.currentLyricIndex + 1); };
  }

  // --- 辅助工具函数 ---
  togglePlayMode() {
    this.state.playMode = this.state.playMode === 'single' ? 'continuous' : 'single';
    this.updatePlayModeUI();
  }
  updatePlayModeUI() {
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
  updateNavigationButtons() {
    this.dom.prevUnitBtn.disabled = this.state.currentUnitIndex <= 0;
    this.dom.nextUnitBtn.disabled = this.state.currentUnitIndex >= this.state.units.length - 1;
  }
  loadPlayModePreference() { this.state.playMode = localStorage.getItem(PLAY_MODE_STORAGE_KEY) || 'single'; }
  loadTranslationPreference() { this.state.translationMode = localStorage.getItem('translationMode') || 'show'; }
  loadRecitePreference() { this.state.reciteMode = localStorage.getItem('reciteMode') === 'true'; }
}

class LRCParser {
  static parse(lrc) {
    return lrc.split('\n').map(line => {
      const m = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.+)/);
      if (!m) return null;
      const time = parseInt(m[1])*60 + parseInt(m[2]) + parseInt(m[3])/1000 - 0.2; // 稍微提前一点点避开切音
      const [en, cn] = m[4].split('|').map(s => s.trim());
      return { time, english: en, chinese: cn || '' };
    }).filter(x => x).sort((a, b) => a.time - b.time);
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  new ReadingSystem();
  // ... 其他 init 函数 ...
});
