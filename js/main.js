// Author: Qim
// Blog: https://ichochy.com
// Email: Qim.it@icloud.com
// FileName: iReader:main.js
// Update: 2025/12/5 19:41
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
      playbackRate: 1.0,
      translationMode: 'show',
      reciteMode: false,
      dictationMode: false, // 新增：听写模式状态
      availableSpeeds: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0],
      savedPlayTime: 0,
      isProgressDragging: false,
      
      currentLyricEndTime: null, 
      maxRepeatCount: 1,         
      currentRepeatCount: 1,     
      repeatOptionIndex: 0       
    };

    this.repeatOptions = [1, 2, 3, 5, Infinity];

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
      reciteModeBtn: qs('#reciteModeBtn'),
      dictationModeBtn: qs('#dictationModeBtn') // 新增：听写按钮
    };

    this.lyricLineEls = [];
    this.unitSelectBound = false;
    this.unitListBound = false;
    this.bookSelectsBound = false;
    this.lyricsBound = false;
    this.lrcCache = new Map();
    this.audioPreload = new Map();

    this.init();
  }

  async init() {
    await this.loadBooks();
    await this.applyBookFromHash();
    this.bindEvents();
    this.loadPlayModePreference();
    this.updatePlayModeUI();
    this.loadTranslationPreference();
    this.updateTranslationToggle();
    
    // 初始化背书与听写配置
    this.loadRecitePreference(); 
    this.updateReciteUI();
    this.loadDictationPreference();
    this.updateDictationUI();
           
    await this.loadUnitFromStorage();
  }

  // ================= 背书模式 ================= //

  loadRecitePreference() {
    const storedMode = localStorage.getItem('reciteMode');
    this.state.reciteMode = storedMode === 'true';
  }

  updateReciteUI() {
    if (!this.dom.reciteModeBtn) return;
    document.body.classList.toggle('recite-mode', this.state.reciteMode);
    
    if (this.state.reciteMode) {
      this.dom.reciteModeBtn.setAttribute('aria-pressed', 'true');
      this.dom.reciteModeBtn.classList.add('active');
      // 如果开启背书，则关闭听写
      if (this.state.dictationMode) this.toggleDictationMode();
    } else {
      this.dom.reciteModeBtn.setAttribute('aria-pressed', 'false');
      this.dom.reciteModeBtn.classList.remove('active');
    }
  }

  toggleReciteMode() {
    this.state.reciteMode = !this.state.reciteMode;
    localStorage.setItem('reciteMode', this.state.reciteMode);
    this.updateReciteUI();
  }

  // ================= 听写模式 (Dictation)核心逻辑 ================= //

  loadDictationPreference() {
    const storedMode = localStorage.getItem('dictationMode');
    this.state.dictationMode = storedMode === 'true';
  }

  updateDictationUI() {
    if (!this.dom.dictationModeBtn) return;
    document.body.classList.toggle('dictation-mode', this.state.dictationMode);
    
    if (this.state.dictationMode) {
      this.dom.dictationModeBtn.setAttribute('aria-pressed', 'true');
      this.dom.dictationModeBtn.classList.add('active');
      // 如果开启听写，则关闭背书
      if (this.state.reciteMode) this.toggleReciteMode();
      
      // 聚焦当前输入框
      setTimeout(() => this.focusCurrentDictationInput(), 100);
    } else {
      this.dom.dictationModeBtn.setAttribute('aria-pressed', 'false');
      this.dom.dictationModeBtn.classList.remove('active');
    }
  }

  toggleDictationMode() {
    this.state.dictationMode = !this.state.dictationMode;
    localStorage.setItem('dictationMode', this.state.dictationMode);
    this.updateDictationUI();
  }

  focusCurrentDictationInput() {
    if (!this.state.dictationMode || this.state.currentLyricIndex < 0) return;
    const activeLine = this.lyricLineEls[this.state.currentLyricIndex];
    if (activeLine) {
      const input = activeLine.querySelector('.dictation-input');
      if (input && document.activeElement !== input) {
        input.focus();
      }
    }
  }

  handleDictationInput(event) {
    if (!this.state.dictationMode) return;
    const inputEl = event.target;
    if (!inputEl.classList.contains('dictation-input')) return;

    const lineEl = inputEl.closest('.lyric-line');
    const index = parseInt(lineEl.dataset.index);
    const originalText = this.state.currentLyrics[index].english;
    const feedbackEl = lineEl.querySelector('.dictation-feedback');

    feedbackEl.innerHTML = this.generateDiffHTML(originalText, inputEl.value);
  }

  generateDiffHTML(original, typed) {
    let html = '';
    let tIdx = 0;
    
    for (let i = 0; i < original.length; i++) {
        const origChar = original[i];
        // 判断是否是字母或数字（核心逻辑：听写只拼写字母数字，自动跳过标点符号）
        const isAlphanumeric = /[a-zA-Z0-9]/.test(origChar);
        
        if (!isAlphanumeric) {
            // 如果用户乖乖输入了标点，我们就吃掉它
            if (typed[tIdx] === origChar) {
                html += `<span class="diff-correct">${origChar}</span>`;
                tIdx++;
            } else {
                // 如果用户没输入标点，自动帮他显示出来，不惩罚错误
                html += `<span class="diff-correct">${origChar}</span>`;
            }
            continue;
        }
        
        // 遇到真实的字母/数字
        if (tIdx < typed.length) {
            const typedChar = typed[tIdx];
            if (origChar.toLowerCase() === typedChar.toLowerCase()) {
                // 对了显示绿色，且保留原句的大小写
                html += `<span class="diff-correct">${origChar}</span>`;
            } else {
                // 错了显示红色并带下划线
                html += `<span class="diff-error">${typedChar}</span>`;
            }
            tIdx++;
        } else {
            // 还没输入的部分显示灰色下划线
            html += `<span class="diff-missing">_</span>`;
        }
    }
    
    // 如果用户手抖多输入了字母
    if (tIdx < typed.length) {
        html += `<span class="diff-error">${typed.substring(tIdx)}</span>`;
    }
    
    return html;
  }

  // ================= 快捷键与 Toast 提示 ================= //

  showToast(message) {
    let toast = document.getElementById('q-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'q-toast';
      toast.style.cssText = `
        position: fixed; top: 15%; left: 50%;
        transform: translate(-50%, -20px);
        background: var(--glass-strong);
        color: var(--accent-1);
        border: 1px solid var(--accent-strong);
        box-shadow: var(--shadow-md);
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        padding: 10px 24px; border-radius: 99px;
        font-size: 15px; font-weight: 600;
        z-index: 10000; pointer-events: none;
        opacity: 0; transition: opacity 0.3s ease, transform 0.3s ease;
        font-family: var(--font-sans);
      `;
      document.body.appendChild(toast);
    }
    
    toast.style.opacity = '0';
    toast.style.transform = 'translate(-50%, -20px)';
    
    setTimeout(() => {
        toast.textContent = message;
        toast.style.opacity = '1';
        toast.style.transform = 'translate(-50%, 0)';
    }, 20);

    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translate(-50%, -20px)';
    }, 2000);
  }

  jumpToLyricImmediate(targetIndex) {
    if (!this.state.currentLyrics || !this.state.currentLyrics.length) return;
    targetIndex = clamp(targetIndex, 0, this.state.currentLyrics.length - 1);
    
    const targetLyric = this.state.currentLyrics[targetIndex];
    if (!targetLyric) return;

    this.playLyricAtIndex(targetIndex, targetLyric.time);
    this.persistPlayTime(targetLyric.time);
    this.updateLyricHighlight();
  }

  bindGlobalShortcuts() {
    if (this.dom.reciteModeBtn) {
      this.dom.reciteModeBtn.addEventListener('click', () => this.toggleReciteMode());
    }
    if (this.dom.dictationModeBtn) {
      this.dom.dictationModeBtn.addEventListener('click', () => this.toggleDictationMode());
    }

    let isCtrlCombination = false;
    let isAltCombination = false;

    document.addEventListener('keydown', (event) => {
      const targetTag = event.target.tagName.toLowerCase();
      const isDictationInput = event.target.classList.contains('dictation-input');

      // 如果当前正在听写打字框里
      if (isDictationInput) {
          // 拦截 Tab 和 Enter 专门为听写服务
          if (event.key === 'Tab') {
              event.preventDefault();
              if (event.shiftKey) {
                  this.jumpToLyricImmediate(this.state.currentLyricIndex - 1); // 相当于 A
              } else {
                  this.jumpToLyricImmediate(this.state.currentLyricIndex);     // 相当于 S
              }
              return;
          }
          if (event.key === 'Enter') {
              event.preventDefault();
              this.jumpToLyricImmediate(this.state.currentLyricIndex + 1);     // 相当于 D
              return;
          }
          // 在输入框里不要触发普通字母快捷键，让他正常打字！
      } 
      // 在普通输入框里(非听写框)什么都不做
      else if (targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select') {
          return; 
      }

      if (event.key !== 'Control' && event.ctrlKey) isCtrlCombination = true;
      if (event.key !== 'Alt' && event.altKey) isAltCombination = true;

      const key = event.key.toLowerCase();
      
      // Q键：切换循环播放次数
      if (key === 'q' && !isDictationInput) {
        event.preventDefault();
        this.state.repeatOptionIndex = (this.state.repeatOptionIndex + 1) % this.repeatOptions.length;
        this.state.maxRepeatCount = this.repeatOptions[this.state.repeatOptionIndex];
        this.state.currentRepeatCount = 1;

        let msg = `当前句播放: ${this.state.maxRepeatCount}遍`;
        if (this.state.maxRepeatCount === Infinity) msg = '当前句播放: 无限循环';
        if (this.state.maxRepeatCount === 1) msg = '当前句播放: 1遍 (默认)';
        this.showToast(msg);
        return;
      }

      // A, S, D 全局控制 (如果没在输入框里)
      if (['a', 's', 'd'].includes(key) && !isDictationInput) {
        event.preventDefault(); 
        let currentIndex = this.state.currentLyricIndex;
        if (currentIndex === -1) currentIndex = 0;

        if (key === 'a') this.jumpToLyricImmediate(currentIndex - 1);
        else if (key === 's') this.jumpToLyricImmediate(currentIndex);
        else if (key === 'd') this.jumpToLyricImmediate(currentIndex + 1);
      }
    });

    document.addEventListener('keyup', (event) => {
      if (event.key === 'Control') {
        if (!isCtrlCombination) this.toggleReciteMode();
        isCtrlCombination = false;
      }
      if (event.key === 'Alt') {
        if (!isAltCombination) this.toggleDictationMode();
        isAltCombination = false;
      }
    });
  }

  // ========================================================= //

  async loadBooks() {
    if (this.state.books.length) return this.state.books;
    try {
      const response = await fetch('data.json');
      const data = await response.json();
      this.state.books = Array.isArray(data.books) ? data.books : [];
    } catch (error) {
      console.error('加载课本数据失败:', error);
      this.state.books = [];
    }
    return this.state.books;
  }

  resolveBookByKey(bookKey) {
    if (!this.state.books.length) return null;
    const exact = this.state.books.find((book) => book && book.key === bookKey);
    if (exact && exact.bookPath) return exact;
    const fallback = this.state.books.find((book) => book && book.key === DEFAULT_BOOK_KEY);
    if (fallback && fallback.bookPath) return fallback;
    return this.state.books.find((book) => book && book.bookPath) || null;
  }

  async applyBookFromHash() {
    const keyFromHash = location.hash.slice(1).trim();
    const storedBookKey = this.loadBookPreference();
    const initialBookKey = keyFromHash || storedBookKey || DEFAULT_BOOK_KEY;
    await this.applyBookChange(initialBookKey);
  }

  loadBookPreference() {
    return localStorage.getItem(BOOK_SELECTION_STORAGE_KEY)?.trim() || '';
  }

  persistBookPreference(bookKey) {
    if (!bookKey) return;
    localStorage.setItem(BOOK_SELECTION_STORAGE_KEY, bookKey);
  }

  async applyBookChange(bookKey) {
    await this.loadBooks();
    const resolved = this.resolveBookByKey(bookKey);

    if (!resolved || !resolved.bookPath) {
      this.state.bookPath = '';
      this.state.bookKey = '';
      this.renderEmptyState('未找到可用课本数据');
      return;
    }

    this.state.bookKey = resolved.key || bookKey;
    this.state.bookPath = resolved.bookPath.trim();
    this.persistBookPreference(this.state.bookKey);

    this.updateBookSelects();
    await this.loadBookConfig();
    this.renderUnitList();
    this.renderUnitSelect();
    this.resetUnitListScroll();
  }

  renderEmptyState(message) {
    if (this.dom.lyricsDisplay) {
      this.dom.lyricsDisplay.innerHTML = `<p class="placeholder">${message}</p>`;
    }
    if (this.dom.unitList) {
      this.dom.unitList.innerHTML = '';
    }
    this.resetUnitListScroll();
  }

  resetUnitListScroll() {
    const scrollContainer = this.dom.unitList?.closest('.unit-list');
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }

  async loadBookConfig() {
    if (!this.state.bookPath) {
      this.renderEmptyState('未找到可用课本数据');
      return;
    }

    try {
      const response = await fetch(`${this.state.bookPath}/book.json`);
      const data = await response.json();

      this.state.units = data.units.map((unit, index) => ({
        ...unit,
        id: index + 1,
        title: unit.title,
        audio: `${this.state.bookPath}/${unit.filename}.mp3`,
        lrc: `${this.state.bookPath}/${unit.filename}.lrc`
      }));

      if (this.dom.bookName) {
        this.dom.bookName.textContent = `《${data.bookName}》`;
      }
      if (this.dom.bookLevel) {
        this.dom.bookLevel.textContent = `${data.bookLevel}`;
      }
      if (this.dom.bookCover && data.bookCover) {
        this.dom.bookCover.src = `${this.state.bookPath}/${data.bookCover}`;
      }
      this.lrcCache.clear();
      this.audioPreload.clear();
    } catch (error) {
      console.error('加载课件配置失败:', error);
      this.renderEmptyState(`课件配置加载失败，请检查 ${this.state.bookPath}/book.json 文件`);
    }
  }

  updateBookSelects() {
    if (!this.dom.bookSelects.length || !this.state.books.length) return;

    const options = this.state.books
      .filter((book) => book && book.key && book.title && book.bookPath)
      .map((book) => `<option value="${book.key}">${book.title}</option>`)
      .join('');

    this.dom.bookSelects.forEach((select) => {
      select.innerHTML = `${options}`;
      if (this.state.bookKey) {
        select.value = this.state.bookKey;
      }
    });
  }

  renderUnitList() {
    if (!this.dom.unitList) return;

    this.dom.unitList.innerHTML = this.state.units
      .map(
        (unit, index) => `
      <div class="unit-item" data-unit-index="${index}" tabindex="0" role="button" aria-label="打开 ${unit.title}">
        <h3>${unit.title}</h3>
      </div>
    `
      )
      .join('');
  }

  renderUnitSelect() {
    if (!this.dom.unitSelect) return;

    const options = this.state.units
      .map((unit, index) => `<option value="${index}">${unit.title}</option>`)
      .join('');

    this.dom.unitSelect.innerHTML = `${options}`;
  }

  async loadUnitFromStorage() {
    if (!this.state.units.length) return;

    const stored = localStorage.getItem(`${this.state.bookPath}/currentUnitIndex`);
    const parsed = stored ? parseInt(stored) : 0;
    const safeIndex = Number.isFinite(parsed)
      ? clamp(parsed, 0, this.state.units.length - 1)
      : 0;

    await this.loadUnitByIndex(safeIndex, { shouldScrollUnitIntoView: true });
  }

  async loadUnitByIndex(unitIndex, options = {}) {
    const { shouldScrollUnitIntoView = false } = options;

    this.state.currentUnitIndex = unitIndex;
    localStorage.setItem(`${this.state.bookPath}/currentUnitIndex`, unitIndex);

    const unit = this.state.units[unitIndex];
    if (!unit) return;

    this.resetPlayer();
    this.updateActiveUnit(unitIndex, { shouldScrollUnitIntoView });
    this.updateNavigationButtons();

    try {
      let lrcText = this.lrcCache.get(unit.lrc);
      if (!lrcText) {
        const response = await fetch(unit.lrc);
        lrcText = await response.text();
        this.lrcCache.set(unit.lrc, lrcText);
      }
      this.state.currentLyrics = LRCParser.parse(lrcText);
      this.renderLyrics();
    } catch (error) {
      console.error('加载歌词失败:', error);
      if (this.dom.lyricsDisplay) {
        this.dom.lyricsDisplay.innerHTML = '<p class="placeholder">加载失败</p>';
      }
    }

    if (this.dom.audioPlayer) {
      this.setPlayButtonDisabled(true);
      this.dom.audioPlayer.src = unit.audio;
      this.dom.audioPlayer.load();
    }

    this.loadPlayTime();
    this.loadSavedSpeed();
    this.prefetchUnit(unitIndex + 1);
  }

  resetPlayer() {
    if (this.dom.audioPlayer) {
      this.dom.audioPlayer.pause();
      this.dom.audioPlayer.currentTime = 0;
    }

    this.setPlayButtonDisabled(true);

    if (this.dom.progressBar) this.dom.progressBar.style.setProperty('--progress', '0%');
    if (this.dom.currentTime) this.dom.currentTime.textContent = '0:00';
    if (this.dom.duration) this.dom.duration.textContent = '0:00';

    this.updatePlayButton();
    this.state.currentLyricIndex = -1;
    this.state.currentLyricEndTime = null;
    this.state.currentRepeatCount = 1;
  }

  updateActiveUnit(unitIndex, options = {}) {
    const { shouldScrollUnitIntoView = false } = options;

    if (this.dom.unitList) {
      let activeItem = null;

      this.dom.unitList.querySelectorAll('.unit-item').forEach((item, index) => {
        if (index === unitIndex) {
          item.classList.add('active');
          activeItem = item;
        } else {
          item.classList.remove('active');
        }
      });

      if (activeItem && shouldScrollUnitIntoView) {
        activeItem.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    }

    if (this.dom.unitSelect) {
      this.dom.unitSelect.value = unitIndex;
    }
  }

  renderLyrics() {
    if (!this.dom.lyricsDisplay) return;

    if (this.dom.lyricsContainer) {
      this.dom.lyricsContainer.scrollTop = 0;
    }

    if (!this.state.currentLyrics.length) {
      this.dom.lyricsDisplay.innerHTML = '<p class="placeholder">没有歌词数据</p>';
      return;
    }

    this.dom.lyricsDisplay.innerHTML = this.state.currentLyrics
      .map((lyric, index) => {
        // 渲染时顺便初始化一份听写下划线占位符
        const feedbackHTML = this.generateDiffHTML(lyric.english, '');
        return `
      <div class="lyric-line" data-index="${index}" data-time="${lyric.time}" tabindex="0" role="button" aria-label="播放第 ${index + 1} 句">
        <div class="lyric-text">${lyric.english}</div>
        ${lyric.chinese ? `<div class="lyric-translation">${lyric.chinese}</div>` : ''}
        
        <!-- 听写区域 (默认隐藏，开启模式并播放到此句时出现) -->
        <div class="dictation-container" onclick="event.stopPropagation()">
            <input type="text" class="dictation-input" placeholder="输入听写内容 (Tab键重读, Enter下一句)" autocomplete="off" spellcheck="false">
            <div class="dictation-feedback">${feedbackHTML}</div>
        </div>
      </div>
    `;
      })
      .join('');

    this.lyricLineEls = qsa('.lyric-line', this.dom.lyricsDisplay);
    this.state.currentLyricIndex = -1;
  }

  handleLyricActivate(line) {
    const index = parseInt(line.dataset.index);
    const time = parseFloat(line.dataset.time);
    this.playLyricAtIndex(index, time);
    this.persistPlayTime(time);
    this.updateLyricHighlight();
  }

  playLyricAtIndex(index, time) {
    if (!this.dom.audioPlayer) return;
    this.dom.audioPlayer.currentTime = time;
    
    const nextLyric = this.state.currentLyrics[index + 1];
    this.state.currentLyricEndTime = nextLyric ? nextLyric.time : this.dom.audioPlayer.duration;
    
    this.state.currentLyricIndex = index;
    this.state.currentRepeatCount = 1; 

    this.dom.audioPlayer.play();
  }

  persistPlayTime(time) {
    localStorage.setItem(`${this.state.bookPath}/${this.state.currentUnitIndex}/playTime`, time);
  }

  checkLyricBoundary() {
    if (!this.dom.audioPlayer || this.state.isProgressDragging) return;

    const enforceBoundary = this.state.playMode === 'single' || this.state.maxRepeatCount > 1;
    if (!enforceBoundary) return;

    const currentTime = this.dom.audioPlayer.currentTime;
    const endTime = this.state.currentLyricEndTime;

    if (endTime && currentTime >= endTime && (currentTime - endTime < 0.8) && endTime !== this.dom.audioPlayer.duration) {
      if (this.state.currentRepeatCount < this.state.maxRepeatCount) {
        this.state.currentRepeatCount++;
        const startTime = this.state.currentLyrics[this.state.currentLyricIndex].time;
        this.dom.audioPlayer.currentTime = startTime;
        this.dom.audioPlayer.play();
      } else {
        this.state.currentRepeatCount = 1; 
        if (this.state.playMode === 'single') {
          this.dom.audioPlayer.pause();
          this.dom.audioPlayer.currentTime = endTime - 0.01;
        } else if (this.state.playMode === 'continuous') {
          this.playNextLyric();
        }
      }
    }
  }

  updateProgress() {
    if (!this.dom.progressBar || !this.dom.audioPlayer) return;

    if (this.dom.audioPlayer.duration && !this.state.isProgressDragging) {
      const percent = (this.dom.audioPlayer.currentTime / this.dom.audioPlayer.duration) * 100;
      this.dom.progressBar.style.setProperty('--progress', `${percent}%`);
      if (this.dom.currentTime) {
        this.dom.currentTime.textContent = this.formatTime(this.dom.audioPlayer.currentTime);
      }
    }
  }

  updateDuration() {
    if (!this.dom.audioPlayer) return;

    if (this.dom.duration) {
      this.dom.duration.textContent = this.formatTime(this.dom.audioPlayer.duration);
    }
    if (this.state.savedPlayTime > 0 && this.dom.audioPlayer.duration) {
      this.dom.audioPlayer.currentTime = Math.min(this.state.savedPlayTime, this.dom.audioPlayer.duration - 0.1);
      this.state.savedPlayTime = 0;
      this.updateProgress();
    }
  }

  updatePlayButton() {
    if (!this.dom.playPauseBtn || !this.dom.audioPlayer) return;

    if (this.dom.audioPlayer.paused) {
      this.dom.playPauseBtn.classList.remove('playing');
    } else {
      this.dom.playPauseBtn.classList.add('playing');
    }
  }

  setPlayButtonDisabled(disabled) {
    if (!this.dom.playPauseBtn) return;
    this.dom.playPauseBtn.disabled = disabled;
    this.dom.playPauseBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  cyclePlaybackSpeed() {
    const currentIndex = this.state.availableSpeeds.indexOf(this.state.playbackRate);
    const nextIndex = (currentIndex + 1) % this.state.availableSpeeds.length;
    this.state.playbackRate = this.state.availableSpeeds[nextIndex];

    if (this.dom.audioPlayer) {
      this.dom.audioPlayer.playbackRate = this.state.playbackRate;
    }

    this.updateSpeedButton();
    localStorage.setItem('playbackRate', this.state.playbackRate);
  }

  updateSpeedButton() {
    if (!this.dom.speedText || !this.dom.speedBtn) return;

    this.dom.speedText.textContent = `${this.state.playbackRate}x`;

    if (this.state.playbackRate !== 1.0) {
      this.dom.speedBtn.classList.add('active');
    } else {
      this.dom.speedBtn.classList.remove('active');
    }
  }

  loadPlayTime() {
    const time = localStorage.getItem(`${this.state.bookPath}/${this.state.currentUnitIndex}/playTime`);
    if (time) {
      const parsed = parseFloat(time);
      if (Number.isFinite(parsed)) {
        this.state.savedPlayTime = parsed;
      }
    }
  }

  loadSavedSpeed() {
    const savedSpeed = localStorage.getItem('playbackRate');
    if (savedSpeed) {
      const parsed = parseFloat(savedSpeed);
      if (!Number.isFinite(parsed)) return;
      this.state.playbackRate = parsed;
      if (this.dom.audioPlayer) {
        this.dom.audioPlayer.playbackRate = this.state.playbackRate;
      }
      this.updateSpeedButton();
    }
  }

  updateNavigationButtons() {
    if (this.dom.prevUnitBtn) {
      this.dom.prevUnitBtn.disabled = this.state.currentUnitIndex <= 0;
    }

    if (this.dom.nextUnitBtn) {
      this.dom.nextUnitBtn.disabled = this.state.currentUnitIndex >= this.state.units.length - 1;
    }
  }

  loadPreviousUnit() {
    if (this.state.currentUnitIndex > 0) {
      this.loadUnitByIndex(this.state.currentUnitIndex - 1);
    }
  }

  loadNextUnit() {
    if (this.state.currentUnitIndex < this.state.units.length - 1) {
      this.loadUnitByIndex(this.state.currentUnitIndex + 1);
    }
  }

  togglePlayMode() {
    this.state.playMode = this.state.playMode === 'single' ? 'continuous' : 'single';
    localStorage.setItem(PLAY_MODE_STORAGE_KEY, this.state.playMode);
    this.updatePlayModeUI();
  }

  updatePlayModeUI() {
    if (!this.dom.playModeBtn) return;

    if (this.state.playMode === 'single') {
      this.dom.playModeBtn.title = '单句点读';
      this.dom.playModeBtn.setAttribute('aria-label', '单句点读');
      this.dom.playModeBtn.setAttribute('aria-pressed', 'false');
      this.dom.playModeBtn.dataset.mode = 'single';
      this.dom.playModeBtn.classList.remove('continuous-mode');
    } else {
      this.dom.playModeBtn.title = '连续点读';
      this.dom.playModeBtn.setAttribute('aria-label', '连续点读');
      this.dom.playModeBtn.setAttribute('aria-pressed', 'true');
      this.dom.playModeBtn.dataset.mode = 'continuous';
      this.dom.playModeBtn.classList.add('continuous-mode');
    }
  }

  loadPlayModePreference() {
    const storedMode = localStorage.getItem(PLAY_MODE_STORAGE_KEY);
    if (storedMode === 'single' || storedMode === 'continuous') {
      this.state.playMode = storedMode;
    }
  }

  handleAudioEnded() {
    if (this.state.currentRepeatCount < this.state.maxRepeatCount) {
      this.state.currentRepeatCount++;
      const startTime = this.state.currentLyrics[this.state.currentLyricIndex]?.time || 0;
      this.dom.audioPlayer.currentTime = startTime;
      this.dom.audioPlayer.play();
      return;
    }

    this.state.currentRepeatCount = 1;
    if (this.state.playMode === 'continuous') {
      this.playNextLyric();
    }
  }

  playNextLyric() {
    const nextIndex = this.state.currentLyricIndex + 1;
    if (nextIndex < this.state.currentLyrics.length && this.dom.audioPlayer) {
      const nextLyric = this.state.currentLyrics[nextIndex];
      this.playLyricAtIndex(nextIndex, nextLyric.time);
    }
  }

  updateLyricHighlight() {
    if (!this.lyricLineEls.length || !this.dom.audioPlayer) return;

    const currentTime = this.dom.audioPlayer.currentTime;
    let newIndex = -1;
    for (let i = this.state.currentLyrics.length - 1; i >= 0; i--) {
      if (currentTime >= this.state.currentLyrics[i].time) {
        newIndex = i;
        break;
      }
    }

    if (newIndex === this.state.currentLyricIndex) return;

    if (this.state.currentLyricIndex >= 0 && this.lyricLineEls[this.state.currentLyricIndex]) {
      this.lyricLineEls[this.state.currentLyricIndex].classList.remove('active');
      this.lyricLineEls[this.state.currentLyricIndex].classList.remove('pulse');
    }

    this.state.currentLyricIndex = newIndex;

    if (newIndex >= 0) {
      const nextLyric = this.state.currentLyrics[newIndex + 1];
      this.state.currentLyricEndTime = nextLyric ? nextLyric.time : this.dom.audioPlayer.duration;
      this.state.currentRepeatCount = 1; 

      const activeLine = this.lyricLineEls[newIndex];
      if (activeLine) {
        activeLine.classList.add('active');
        activeLine.classList.add('pulse');
        if (this.shouldScrollLyricIntoView(activeLine)) {
          activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        
        // 如果处于听写模式，自动聚焦输入框
        if (this.state.dictationMode) {
          const input = activeLine.querySelector('.dictation-input');
          if (input && document.activeElement !== input) {
            input.focus();
          }
        }
      }
    }
  }

  prefetchUnit(unitIndex) {
    const unit = this.state.units[unitIndex];
    if (!unit) return;

    if (unit.lrc && !this.lrcCache.has(unit.lrc)) {
      fetch(unit.lrc)
        .then((response) => response.text())
        .then((text) => this.lrcCache.set(unit.lrc, text))
        .catch(() => {});
    }

    if (unit.audio && !this.audioPreload.has(unit.audio)) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.src = unit.audio;
      this.audioPreload.set(unit.audio, audio);
    }
  }

  shouldScrollLyricIntoView(activeLine) {
    if (!this.dom.lyricsContainer) return true;
    const containerRect = this.dom.lyricsContainer.getBoundingClientRect();
    const lineRect = activeLine.getBoundingClientRect();
    const topThreshold = containerRect.top + containerRect.height * 0.22;
    const bottomThreshold = containerRect.bottom - containerRect.height * 0.22;
    return lineRect.top < topThreshold || lineRect.bottom > bottomThreshold;
  }

  bindEvents() {
    this.bindBookSelects();
    this.bindUnitList();
    this.bindUnitSelect();
    this.bindLyrics();
    this.bindPlayerControls();
    this.bindNavigation();
    this.bindTranslationToggle();
    this.bindGlobalShortcuts(); 
    
    // 委托绑定输入框的 input 事件，避免每句生成一个监听器
    if (this.dom.lyricsDisplay) {
      this.dom.lyricsDisplay.addEventListener('input', (event) => {
        this.handleDictationInput(event);
      });
    }

    window.addEventListener('hashchange', () => {
      const newKey = location.hash.slice(1).trim() || DEFAULT_BOOK_KEY;
      if (newKey === this.state.bookKey) return;
      this.applyBookChange(newKey).then(() => this.loadUnitFromStorage());
    });
  }

  bindTranslationToggle() {
    if (!this.dom.toggleTranslationBtn) return;
    this.dom.toggleTranslationBtn.addEventListener('click', () => {
      const modes = ['show', 'hide', 'blur'];
      const currentIndex = modes.indexOf(this.state.translationMode);
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modes.length;
      this.state.translationMode = modes[nextIndex];
      localStorage.setItem('translationMode', this.state.translationMode);
      this.updateTranslationToggle();
    });
  }

  loadTranslationPreference() {
    const storedMode = localStorage.getItem('translationMode');
    if (storedMode === 'show' || storedMode === 'hide' || storedMode === 'blur') {
      this.state.translationMode = storedMode;
    }
  }

  updateTranslationToggle() {
    if (!this.dom.toggleTranslationBtn) return;
    const mode = this.state.translationMode;
    document.body.classList.toggle('hide-translation', mode === 'hide');
    document.body.classList.toggle('blur-translation', mode === 'blur');

    if (mode === 'show') {
      this.dom.toggleTranslationBtn.textContent = '中';
      this.dom.toggleTranslationBtn.setAttribute('aria-pressed', 'true');
      this.dom.toggleTranslationBtn.setAttribute('aria-label', '翻译显示');
    } else if (mode === 'blur') {
      this.dom.toggleTranslationBtn.textContent = '模';
      this.dom.toggleTranslationBtn.setAttribute('aria-pressed', 'mixed');
      this.dom.toggleTranslationBtn.setAttribute('aria-label', '翻译模糊显示');
    } else {
      this.dom.toggleTranslationBtn.textContent = '英';
      this.dom.toggleTranslationBtn.setAttribute('aria-pressed', 'false');
      this.dom.toggleTranslationBtn.setAttribute('aria-label', '仅显示英文');
    }
  }

  bindBookSelects() {
    if (this.bookSelectsBound || !this.dom.bookSelects.length) return;
    this.bookSelectsBound = true;

    this.dom.bookSelects.forEach((select) => {
      select.addEventListener('change', (event) => {
        const target = event.target;
        if (!target.value) return;
        if (location.hash.slice(1) === target.value) return;
        location.hash = target.value;
      });
    });
  }

  bindUnitList() {
    if (this.unitListBound || !this.dom.unitList) return;
    this.unitListBound = true;

    this.dom.unitList.addEventListener('click', (event) => {
      const item = event.target.closest('.unit-item');
      if (!item) return;
      const unitIndex = parseInt(item.dataset.unitIndex);
      this.loadUnitByIndex(unitIndex);
    });

    this.dom.unitList.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('.unit-item');
      if (!item) return;
      event.preventDefault();
      const unitIndex = parseInt(item.dataset.unitIndex);
      this.loadUnitByIndex(unitIndex);
    });
  }

  bindUnitSelect() {
    if (this.unitSelectBound || !this.dom.unitSelect) return;
    this.unitSelectBound = true;

    this.dom.unitSelect.addEventListener('change', (event) => {
      const unitIndex = parseInt(event.target.value);
      if (unitIndex >= 0) {
        this.loadUnitByIndex(unitIndex);
      }
    });
  }

  bindLyrics() {
    if (this.lyricsBound || !this.dom.lyricsDisplay) return;
    this.lyricsBound = true;

    this.dom.lyricsDisplay.addEventListener('click', (event) => {
      const line = event.target.closest('.lyric-line');
      // 如果点击的是输入框本身，不要触发跳句
      if (!line || event.target.classList.contains('dictation-input')) return;
      this.handleLyricActivate(line);
    });

    this.dom.lyricsDisplay.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const line = event.target.closest('.lyric-line');
      // 如果是输入框里的回车，不要在这里触发默认播放，交给快捷键逻辑处理
      if (!line || event.target.classList.contains('dictation-input')) return;
      event.preventDefault();
      this.handleLyricActivate(line);
    });
  }

  bindPlayerControls() {
    if (
      !this.dom.playPauseBtn ||
      !this.dom.speedBtn ||
      !this.dom.progressBar ||
      !this.dom.audioPlayer ||
      !this.dom.playModeBtn
    ) {
      return;
    }

    this.dom.playPauseBtn.addEventListener('click', () => {
      if (this.dom.audioPlayer.paused) {
        this.dom.audioPlayer.play();
      } else {
        this.dom.audioPlayer.pause();
      }
    });

    this.dom.speedBtn.addEventListener('click', () => {
      this.cyclePlaybackSpeed();
    });

    const seekByClientX = (clientX) => {
      if (!this.dom.audioPlayer.duration) return;
      const rect = this.dom.progressBar.getBoundingClientRect();
      const percent = clamp((clientX - rect.left) / rect.width, 0, 1);
      this.dom.audioPlayer.currentTime = percent * this.dom.audioPlayer.duration;
    };

    this.dom.progressBar.addEventListener('click', (event) => {
      seekByClientX(event.clientX);
    });

    this.dom.progressBar.addEventListener('pointerdown', (event) => {
      this.state.isProgressDragging = true;
      this.dom.progressBar.classList.add('dragging');
      this.dom.progressBar.setPointerCapture(event.pointerId);
      seekByClientX(event.clientX);
    });

    this.dom.progressBar.addEventListener('pointermove', (event) => {
      if (!this.state.isProgressDragging) return;
      seekByClientX(event.clientX);
    });

    this.dom.progressBar.addEventListener('pointerup', (event) => {
      this.state.isProgressDragging = false;
      this.dom.progressBar.classList.remove('dragging');
      this.dom.progressBar.releasePointerCapture(event.pointerId);
    });

    this.dom.progressBar.addEventListener('pointercancel', () => {
      this.state.isProgressDragging = false;
      this.dom.progressBar.classList.remove('dragging');
    });

    this.dom.progressBar.addEventListener('pointerleave', () => {
      this.state.isProgressDragging = false;
      this.dom.progressBar.classList.remove('dragging');
    });

    this.dom.playModeBtn.addEventListener('click', () => {
      this.togglePlayMode();
    });

    this.dom.audioPlayer.addEventListener('timeupdate', () => {
      this.checkLyricBoundary();
      this.updateLyricHighlight();
      this.updateProgress();
    });

    this.dom.audioPlayer.addEventListener('loadedmetadata', () => {
      this.updateDuration();
    });

    this.dom.audioPlayer.addEventListener('canplay', () => {
      this.setPlayButtonDisabled(false);
    });

    this.dom.audioPlayer.addEventListener('loadstart', () => {
      this.setPlayButtonDisabled(true);
    });

    this.dom.audioPlayer.addEventListener('ended', () => {
      this.handleAudioEnded();
      this.updatePlayButton();
    });

    this.dom.audioPlayer.addEventListener('play', () => {
      this.updatePlayButton();
    });

    this.dom.audioPlayer.addEventListener('pause', () => {
      this.updatePlayButton();
    });

    this.dom.audioPlayer.addEventListener('error', () => {
      this.setPlayButtonDisabled(true);
    });
  }

  bindNavigation() {
    if (this.dom.prevUnitBtn) {
      this.dom.prevUnitBtn.addEventListener('click', () => {
        this.loadPreviousUnit();
      });
    }

    if (this.dom.nextUnitBtn) {
      this.dom.nextUnitBtn.addEventListener('click', () => {
        this.loadNextUnit();
      });
    }
  }
}

// 初始化系统
document.addEventListener('DOMContentLoaded', () => {
  new ReadingSystem();
  initThemeToggle();
  initSupportModal();
});

// 主题切换功能
function initThemeToggle() {
  const themeToggle = document.getElementById('themeToggle');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  if (!themeToggle) return;

  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark' || (!savedTheme && prefersDark.matches)) {
    document.body.classList.add('dark-theme');
  }

  themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-theme');
    const isDark = document.body.classList.contains('dark-theme');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');

    themeToggle.style.transform = 'rotate(360deg)';
    setTimeout(() => {
      themeToggle.style.transform = '';
    }, 300);
  });

  prefersDark.addEventListener('change', (event) => {
    if (!localStorage.getItem('theme')) {
      if (event.matches) {
        document.body.classList.add('dark-theme');
      } else {
        document.body.classList.remove('dark-theme');
      }
    }
  });
}

function initSupportModal() {
  const supportBtn = document.getElementById('supportBtn');
  const supportModal = document.getElementById('supportModal');
  const supportCloseBtn = document.getElementById('supportCloseBtn');

  if (!supportBtn || !supportModal || !supportCloseBtn) {
    return;
  }

  const openModal = () => {
    supportModal.classList.add('open');
    supportModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };

  const closeModal = () => {
    supportModal.classList.remove('open');
    supportModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  supportBtn.addEventListener('click', openModal);
  supportCloseBtn.addEventListener('click', closeModal);

  supportModal.addEventListener('click', (event) => {
    if (event.target === supportModal) {
      closeModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && supportModal.classList.contains('open')) {
      closeModal();
    }
  });
}

// LRC 解析器
class LRCParser {
  static parse(lrcText) {
    const lines = lrcText.split('\n');
    const lyrics = [];

    for (const line of lines) {
      const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.+)/);
      if (match) {
        const minutes = parseInt(match[1]);
        const seconds = parseInt(match[2]);
        const milliseconds = parseInt(match[3]);
        const time = minutes * 60 + seconds + milliseconds / 1000 - 0.5;

        const text = match[4].trim();
        const parts = text.split('|').map((p) => p.trim());

        lyrics.push({
          time,
          english: parts[0] || '',
          chinese: parts[1] || '',
          fullText: text
        });
      }
    }

    return lyrics.sort((a, b) => a.time - b.time);
  }
}
