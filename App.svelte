<script>
  import { onMount, tick } from 'svelte';

  // Svelte state variables
  let meta = $state({ pageOrder: [], stickers: [], placedImages: [], regions: [] });
  let pages = $state({});
  let currentP = $state(0);
  let isScrubbing = $state(false);
  let zoomedImgId = $state(null);
  
  let stickerDrawerOpen = $state(false);
  let loadedStickers = $state([]);
  
  let contextMenuVisible = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);
  let contextMenuItems = $state([]);

  let isDrawingRegion = $state(false);
  let tempRegion = $state({ x: 0, y: 0, w: 0, h: 0 });
  let regionDragId = $state(null);
  let imgDragId = $state(null);
  let blockDraggingId = $state(null);
  
  let pageWrappers = {};
  let blockElements = {};
  let blockTexts = {};
  let loadedImages = $state({});

  // ==========================================
  // 1. CONSTANTS & CONFIGURATION
  // ==========================================
  const CONFIG = {
    BULLETS: { task: "•", completed: "✕", migrated: ">", scheduled: "<", event: "○", note: "-" },
    CYCLE: ["task", "completed", "migrated", "scheduled", "event", "note"],
    MD_MAP: { "* ": "task", "x ": "completed", "> ": "migrated", "< ": "scheduled", "o ": "event", "- ": "note", "# ": "h1", "## ": "h2", "### ": "h3", "#### ": "h4", "##### ": "h5", "###### ": "h6" },
    H_STYLES: { h1: "text-4xl font-bold mt-6 mb-2", h2: "text-3xl font-bold mt-5 mb-2", h3: "text-2xl font-bold mt-4 mb-1", h4: "text-xl font-semibold mt-3 mb-1", h5: "text-lg font-semibold mt-2 mb-1", h6: "text-base font-semibold uppercase tracking-wider mt-2 mb-1 text-zinc-500" },
    SAVE_TIMEOUT_MS: 500,
    LAYERS: ['background', 'paper', 'sticker', 'floating', 'focus'],
    OPACITIES: [1, 0.75, 0.5, 0.25],
    INDENT_PX: 28,
    MIN_REGION_SIZE: 50,
    KEY_JUMP_THRESHOLD: 24,
    MAX_DEPTH: 4
  };

  const DOM_IDS = {
    APP: "app", INDICATOR: "page-indicator", STICKER_TOGGLE: "sticker-toggle",
    STICKER_DRAWER: "sticker-drawer", STICKER_UPLOAD: "sticker-upload", STICKER_GRID: "sticker-grid",
    CONTEXT_MENU: "custom-context-menu"
  };

  // ==========================================
  // 3. PURE FUNCTIONS / HELPERS
  // ==========================================
  const Utils = {
    generateId: () => crypto.randomUUID(),
    clamp: (val, min, max) => Math.max(min, Math.min(max, val)),
    calcRectOffset: (clientX, clientY, rect) => ({ x: clientX - rect.left, y: clientY - rect.top }),
    isInsideRect: (clientX, clientY, rect) => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom,
    isBetweenHorizontally: (clientX, rect) => clientX >= rect.left && clientX <= rect.right,
    findWrapperByCoords(wrappers, clientX) {
      return wrappers.find(w => w && this.isBetweenHorizontally(clientX, w.getBoundingClientRect())) || wrappers[0];
    },
    getBlockClasses(type) {
      const base = "flex-1 outline-none whitespace-pre-wrap min-h-[1.5rem] bullet-text transition-all duration-300";
      const typo = CONFIG.H_STYLES[type] || "text-[1.05rem] leading-relaxed";
      const extra = type === "completed" ? "line-through text-zinc-400 opacity-60" : ["migrated", "scheduled"].includes(type) ? "italic text-zinc-500" : "";
      return `${base} ${typo} ${extra}`.trim();
    },
    getHandleClasses(isB) {
      return `absolute -left-8 top-0.5 w-7 h-7 flex items-center justify-center bullet-handle ${isB ? "opacity-40 text-zinc-500" : "opacity-0 text-zinc-300"} group-hover:opacity-100 hover:!text-black font-bold transition-all`;
    },
    getNextType(currentType) {
      const idx = CONFIG.CYCLE.indexOf(currentType);
      return idx === -1 ? "task" : CONFIG.CYCLE[(idx + 1) % CONFIG.CYCLE.length];
    },
    getNextLayer(currentLayer, dir) {
      const idx = CONFIG.LAYERS.indexOf(currentLayer);
      return CONFIG.LAYERS[this.clamp(idx + dir, 0, CONFIG.LAYERS.length - 1)];
    },
    getNextOpacity(currentOpacity) {
      const idx = CONFIG.OPACITIES.indexOf(currentOpacity ?? 1);
      return CONFIG.OPACITIES[(idx + 1) % CONFIG.OPACITIES.length];
    },
    gid: (id) => document.getElementById(id),
    qsa: (selector) => document.querySelectorAll(selector)
  };

  // ==========================================
  // 4. DATA STORAGE
  // ==========================================
  const api = window.electronAPI;
  const memFs = new Map();

  const FileSystemAPI = {
    readJson: async (path) => api ? await api.readJson(path) : (memFs.get(path) ?? null),
    writeJsonAtomic: async (path, data) => api ? await api.writeJsonAtomic(path, data) : memFs.set(path, data),
    trashJson: async (path) => api ? await api.trashJson(path) : memFs.delete(path),
  };

  const StorageManager = {
    saveTimeout: null, isSaving: false, needsSave: false, dirtyPages: new Set(),
    async loadNotebookMeta() {
      const m = await FileSystemAPI.readJson("meta.json") || {};
      return { version: 4, currentP: 0, pageOrder: [], scrolls: [], stickers: [], placedImages: [], regions: [], lines: [], ...m };
    },
    async executeSave(forceRender = false) {
      if (this.isSaving) return (this.needsSave = true);
      this.isSaving = true; 
      this.needsSave = false;
      
      try {
        await StateManager.cleanEmptySpreads();
        meta.currentP = currentP;
        
        // 🌟 FIX: Unwrap the proxy before sending to Electron!
        const pureMeta = $state.snapshot(meta);
        await FileSystemAPI.writeJsonAtomic("meta.json", pureMeta);

        const pagesToSave = new Set(this.dirtyPages);
        this.dirtyPages.clear();

        for (const pageId of pagesToSave) {
          if (pages[pageId]) {
            // 🌟 FIX: Unwrap the page data proxy!
            const purePage = $state.snapshot(pages[pageId]);
            await FileSystemAPI.writeJsonAtomic(`pages/${pageId}.json`, purePage);
          }
        }

      } catch (error) {
        console.error("Failed to save! 😿", error);
      } finally {
        this.isSaving = false;
        // If a save was requested WHILE we were saving, trigger it again
        if (this.needsSave) this.executeSave();
      }
    },
    
    requestSave(forceRender = false) {
      clearTimeout(this.saveTimeout);
      // 500ms debounce buffer ⏱️
      this.saveTimeout = setTimeout(() => this.executeSave(forceRender), CONFIG.SAVE_TIMEOUT_MS);
    },
  };

  // ==========================================
  // 5. STATE MANAGEMENT
  // ==========================================
  const StateManager = {
    blockMap: new Map(),
    
    createBlock: (text = "", depth = 0, type = "text") => ({ id: Utils.generateId(), type, text, depth }),
    
    async init() {
      const loadedMeta = await StorageManager.loadNotebookMeta();
      if (loadedMeta.pageOrder.length === 0) {
        loadedMeta.pageOrder.push(`page-${Utils.generateId()}`, `page-${Utils.generateId()}`);
        await FileSystemAPI.writeJsonAtomic("meta.json", loadedMeta);
      }
      
      meta = loadedMeta;
      pages = {};
      
      await Promise.all(meta.regions.map(async r => {
        if (!pages[r.pageId]) {
          pages[r.pageId] = await FileSystemAPI.readJson(`pages/${r.pageId}.json`) || [this.createBlock()];
        }
      }));
      
      currentP = meta.currentP || 0;
      this.rebuildIndex();
    },

    rebuildIndex() {
      this.blockMap.clear();
      Object.entries(pages).forEach(([pageId, pageBlocks]) => {
        pageBlocks.forEach((block, bIdx) => this.blockMap.set(block.id, { pageId, bIdx, block }));
      });
    },

    getBlockCoords: (id) => StateManager.blockMap.get(id) || null,

    async cleanEmptySpreads() {
      let changed = false;
      while (meta.pageOrder.length > 1 && (meta.pageOrder.length - 1) !== currentP) {
        const i = meta.pageOrder.length - 1;
        const pId = meta.pageOrder[i];
        
        const isEmpty = (surfaceId) => !meta.placedImages.some(img => img.pageId === surfaceId) && !meta.regions.some(r => r.surfaceId === surfaceId);
        
        if (isEmpty(pId)) {
          delete pages[pId];
          meta.pageOrder.splice(i, 1); meta.scrolls.splice(i, 1);
          changed = true;
        } else break;
      }
      if (currentP >= meta.pageOrder.length) { currentP = Math.max(0, meta.pageOrder.length - 1); changed = true; }
      if (changed) this.rebuildIndex();
      return changed;
    },

    async ensureEnoughPages() {
      if (currentP >= meta.pageOrder.length) {
        const newPageId = `page-${Utils.generateId()}`;
        meta.pageOrder.push(newPageId);
        this.rebuildIndex();
        await FileSystemAPI.writeJsonAtomic("meta.json", meta);
        return true;
      }
      return false;
    },

    async updateBlock(id, updates) {
      const c = this.getBlockCoords(id);
      if (c) {
        Object.assign(c.block, updates);
        StorageManager.dirtyPages.add(c.pageId);
        StorageManager.requestSave();        
        // Sync DOM without re-render for this specific block
        if (updates.text !== undefined && blockTexts[id]) {
          if (document.activeElement !== blockTexts[id]) {
            blockTexts[id].innerText = c.block.text;
          }
        }
      }
    },

    async addBlock(newBlock, idAfter) {
      const c = this.getBlockCoords(idAfter);
      if (!c) return;
      const { pageId, bIdx } = c;
      pages[pageId].splice(bIdx + 1, 0, newBlock);
      this.rebuildIndex();
      StorageManager.dirtyPages.add(pageId);
      StorageManager.requestSave();
    },

    async removeBlock(id) {
      const c = this.getBlockCoords(id);
      if (!c) return;
      const { pageId, bIdx } = c;
      pages[pageId].splice(bIdx, 1);
      this.rebuildIndex();
      StorageManager.dirtyPages.add(pageId);
      StorageManager.requestSave();
    },

    async moveBlockDOM(id, targetId, insertAfter) {
      const src = this.getBlockCoords(id), tgt = this.getBlockCoords(targetId);
      if (!src || !tgt) return;
      
      const srcArray = pages[src.pageId];
      const tgtArray = pages[tgt.pageId];
      
      const [moved] = srcArray.splice(src.bIdx, 1);
      const sameArray = (src.pageId === tgt.pageId);
      let iIdx = tgt.bIdx - (sameArray && src.bIdx < tgt.bIdx ? 1 : 0) + (insertAfter ? 1 : 0);
      
      tgtArray.splice(iIdx, 0, moved);
      this.rebuildIndex();
      
      StorageManager.dirtyPages.add(src.pageId);
      if (!sameArray) StorageManager.dirtyPages.add(tgt.pageId);
      StorageManager.requestSave();
    },
    
    async changePage(dirOrIdx, isRelative = true) {
      const nextP = isRelative ? currentP + dirOrIdx : dirOrIdx;
      if (nextP < 0) return;
      currentP = nextP;
      await this.ensureEnoughPages();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await StorageManager.executeSave();
    }
  };

  // ==========================================
  // CORE MANAGERS (Listening to Events)
  // ==========================================
  const SelectionManager = {
    async focusBlockAsync(id, offset = 0, atEnd = false) {
      await tick(); // Wait for Svelte to render
      this.focusBlock(id, offset, atEnd);
    },
    getCaretPos(el) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return 0;
      const r = sel.getRangeAt(0).cloneRange();
      r.selectNodeContents(el); r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
      return r.toString().length;
    },
    focusBlock(id, offset = 0, atEnd = false) {
      const el = blockTexts[id];
      if (!el) return;
      el.focus();
      const range = document.createRange(), sel = window.getSelection();
      if (atEnd) {
        range.selectNodeContents(el); range.collapse(false);
      } else if (el.firstChild?.nodeType === Node.TEXT_NODE) {
        range.setStart(el.firstChild, Math.min(offset, el.firstChild.length)); range.collapse(true);
      } else {
        range.setStart(el, 0); range.collapse(true);
      }
      sel.removeAllRanges(); sel.addRange(range);
    }
  };

  const StickerBookManager = {
    async saveSticker(base64Src) {
      const id = Utils.generateId();
      await FileSystemAPI.writeJsonAtomic(`images/sticker-${id}.json`, { src: base64Src });
      meta.stickers.push(id);
      await StorageManager.executeSave();
      this.render();
    },
    async removeSticker(id) {
      const idx = meta.stickers.indexOf(id);
      if (idx !== -1) {
        meta.stickers.splice(idx, 1);
        await StorageManager.executeSave();
        this.render();
        await FileSystemAPI.trashJson(`images/sticker-${id}.json`);
      }
    },
    async render() {
      const promises = meta.stickers.map(async id => {
        const file = await FileSystemAPI.readJson(`images/sticker-${id}.json`);
        return file ? { id, src: file.src } : null;
      });
      loadedStickers = (await Promise.all(promises)).filter(Boolean);
    }
  };

  const ImageManager = {
    async spawn(src, clientX, clientY) {
      const id = Utils.generateId();
      await FileSystemAPI.writeJsonAtomic(`images/${id}.json`, { src });

      let left = 100, top = 100;
      let pageId = meta.pageOrder[currentP];
      if (clientX !== undefined && clientY !== undefined) {
        left = clientX - 50; 
        top = clientY - 50;
        }        
        
      }

      const imgData = { id, pageId, left, top, layerBucket: 'sticker' };
      meta.placedImages.push(imgData);      
      await StorageManager.executeSave();
      this.renderImage(imgData);
    },
    async renderImage(data) {
      const file = await FileSystemAPI.readJson(`images/${data.id}.json`);
      if (file && file.src) {
        loadedImages[data.id] = file.src; 
      }
    },
    async updateImage(id, updates) {
    const imgData = meta.placedImages.find(i => i.id === id);
      if (!imgData) return;
      Object.assign(imgData, updates);
      StorageManager.requestSave();
    },
    restoreAll() {
      meta.placedImages.forEach(data => this.renderImage(data));
    },
    async removeImage(id) {
      const idx = meta.placedImages.findIndex(i => i.id === id);
      if (idx !== -1) {
        meta.placedImages.splice(idx, 1);
        await StorageManager.executeSave();
        delete loadedImages[id];
        FileSystemAPI.trashJson(`images/${id}.json`);
      }
    }
  };

  const RegionManager = {
    startX: 0, startY: 0, surfaceId: null,
    startDrawing(e) {
      const wrapper = e.target.closest('.page-wrapper');
      if (!wrapper || e.target.closest('.region-box') || e.target.closest('.draggable-image') || e.target.closest('button') || e.target.closest('#sticker-drawer') || e.target.closest('#page-indicator')) return;
      
      isDrawingRegion = true;
      this.surfaceId = wrapper.dataset.pageId;
      const offset = Utils.calcRectOffset(e.clientX, e.clientY, wrapper.getBoundingClientRect());
      this.startX = offset.x; this.startY = offset.y;
      
      tempRegion = { x: this.startX, y: this.startY, w: 0, h: 0, surfaceId: this.surfaceId };
    },
    draw(e) {
      if (!isDrawingRegion) return;
      const wrapper = pageWrappers[this.surfaceId];
      if (!wrapper) return;
      
      const offset = Utils.calcRectOffset(e.clientX, e.clientY, wrapper.getBoundingClientRect());
      tempRegion.x = Math.min(this.startX, offset.x);
      tempRegion.y = Math.min(this.startY, offset.y);
      tempRegion.w = Math.abs(offset.x - this.startX);
      tempRegion.h = Math.abs(offset.y - this.startY);
    },
    async stopDrawing(e) {
      if (!isDrawingRegion) return;
      isDrawingRegion = false;
      
      if (tempRegion.w > CONFIG.MIN_REGION_SIZE && tempRegion.h > CONFIG.MIN_REGION_SIZE) {
        const regionId = Utils.generateId(), pageId = `page-${Utils.generateId()}`;
        const region = { id: regionId, surfaceId: this.surfaceId, x: tempRegion.x, y: tempRegion.y, width: tempRegion.w, height: tempRegion.h, pageId };
        
        meta.regions.push(region);
        pages[pageId] = [StateManager.createBlock()];
        StateManager.rebuildIndex();
        StorageManager.dirtyPages.add(pageId);
        await StorageManager.executeSave();
        
        SelectionManager.focusBlockAsync(pages[pageId][0].id);
      }
    }
  };

  const EditorEngine = {
    setBlockType(id, type) { StateManager.updateBlock(id, { type }); },
    indentBlock(id, dir) {
      const c = StateManager.getBlockCoords(id);
      if (c) StateManager.updateBlock(id, { depth: Utils.clamp(c.block.depth + dir, 0, CONFIG.MAX_DEPTH) });
    },
    updateText(id, newText) {
      const coords = StateManager.getBlockCoords(id);
      if (!coords) return;

      let { text, type } = coords.block;
      let processedText = newText;
      let newType = type;

      // Check for markdown shortcuts
      for (const [prefix, t] of Object.entries(CONFIG.MD_MAP)) {
        if (processedText.startsWith(prefix)) {
          newType = t;
          processedText = processedText.substring(prefix.length);
          break;
        }
      }

      const isMarkdownChange = (processedText !== newText);
      
      // Update the underlying data
      StateManager.updateBlock(id, { text: processedText, type: newType });

      if (isMarkdownChange) {
        // Manually update DOM and place cursor at end
        const el = blockTexts[id];
        if (el && document.activeElement === el) {
          el.innerText = processedText;
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }

      if (newType !== type) {
        SelectionManager.focusBlockAsync(id);
      }
    },
    syncBlockText(id, newText) {
      const el = blockTexts[id];
      if (el && document.activeElement !== el) {
        // Update DOM only if not focused (external change)
        if (el.innerText !== newText) el.innerText = newText;
      }
      // If focused, do nothing – user is typing, don't disturb
    },
    cycleType(id) {
      const c = StateManager.getBlockCoords(id);
      if (c) this.setBlockType(id, Utils.getNextType(c.block.type));
    },
    splitBlock(id, caretPos) {
      const c = StateManager.getBlockCoords(id);
      if (!c) return;
      const { block } = c;
      const newType = block.type.startsWith("h") ? "text" : block.type;
      const newBlock = StateManager.createBlock(block.text.slice(caretPos), block.depth, newType);
      
      StateManager.updateBlock(id, { text: block.text.slice(0, caretPos) });
      StateManager.addBlock(newBlock, id);
      
      // Manually sync DOM immediately
      const origEl = blockTexts[id];
      if (origEl) origEl.innerText = block.text.slice(0, caretPos);
      
      tick().then(() => {
        const newEl = blockTexts[newBlock.id];
        if (newEl) {
          newEl.innerText = newBlock.text;
          SelectionManager.focusBlockAsync(newBlock.id);
        }
      });
    },
    mergeWithPrevious(id) {
      const c = StateManager.getBlockCoords(id);
      if (!c || c.bIdx === 0) return;
      const prev = pages[c.pageId][c.bIdx - 1];
      const merged = prev.text + c.block.text;
      
      StateManager.updateBlock(prev.id, { text: merged });
      StateManager.removeBlock(id);
      
      const prevEl = blockTexts[prev.id];
      if (prevEl) prevEl.innerText = merged;
      SelectionManager.focusBlockAsync(prev.id, prev.text.length);
    },
    navigateVertical(id, dir) {
      const el = blockElements[id];
      if (!el) return;
      const target = dir === -1 ? el.previousElementSibling : el.nextElementSibling;
      if (target) SelectionManager.focusBlockAsync(target.dataset.id, 0, dir === -1);
    },
    setBlockTextContent(id) {
      const el = blockTexts[id];
      if (!el) return;
      const coords = StateManager.getBlockCoords(id);
      if (coords && el.innerText !== coords.block.text) {
        el.innerText = coords.block.text;
      }
    }
  };

  // ==========================================
  // 8. EVENT CONTROLLER
  // ==========================================
  const EventController = {
    imgDrag: { id: null, offsetX: 0, offsetY: 0 },
    regionDrag: { id: null, type: null, offsetX: 0, offsetY: 0, startX: 0, startY: 0, startW: 0, startH: 0 },
    draggedId: null,
    ticking: false,

    init() {
      // Global events we must bind manually
      this.boundMouseMove = this.handleMouseMove.bind(this);
      this.boundMouseUp = this.handleMouseUp.bind(this);
      this.boundPaste = this.handlePaste.bind(this);
      this.boundDrop = this.handleDrop.bind(this);
      this.boundClick = () => contextMenuVisible = false;
      this.boundContextMenu = () => contextMenuVisible = false;

      window.addEventListener("mousemove", this.boundMouseMove);
      window.addEventListener("mouseup", this.boundMouseUp);
      document.addEventListener("paste", this.boundPaste);
      document.addEventListener("drop", this.boundDrop);
      
      // Global unhandled clicks close context menu
      document.addEventListener("click", this.boundClick);
      document.addEventListener("contextmenu", this.boundContextMenu);
    },
    
    destroy() {
      window.removeEventListener("mousemove", this.boundMouseMove);
      window.removeEventListener("mouseup", this.boundMouseUp);
      document.removeEventListener("paste", this.boundPaste);
      document.removeEventListener("drop", this.boundDrop);
      document.removeEventListener("click", this.boundClick);
      document.removeEventListener("contextmenu", this.boundContextMenu);
    },
    
    handleMouseDown(e) {
      if (e.button !== 0) return;

      const handle = e.target.closest(".bullet-handle");
      if (handle) {
        const block = handle.closest(".bullet-block");
        blockDraggingId = block.dataset.id;
        const clean = () => { blockDraggingId = null; document.removeEventListener("mouseup", clean); handle.removeEventListener("mouseleave", clean); };
        document.addEventListener("mouseup", clean); handle.addEventListener("mouseleave", clean);
        return;
      }
      
      const img = e.target.closest(".draggable-image");
      if (img && img.dataset.locked !== "true") {
        const wrapper = img.closest('.page-wrapper');
        const wrapperRect = wrapper.getBoundingClientRect();
        const imgData = meta.placedImages.find(i => i.id === img.dataset.imgId);
        if(!imgData) return;
        const imgLeft = imgData.left || 0;
        const imgTop = imgData.top || 0;
        
        const offsetX = (e.clientX - wrapperRect.left) - imgLeft;
        const offsetY = (e.clientY - wrapperRect.top) - imgTop;

        imgDragId = img.dataset.imgId;
        this.imgDrag = { id: imgDragId, offsetX, offsetY };
        return e.preventDefault(), e.stopPropagation();
      }
      
      const resizer = e.target.closest('.region-resizer');
      if (resizer) {
        const rb = resizer.closest('.region-box');
        regionDragId = rb.dataset.regionId;
        this.regionDrag = { id: regionDragId, type: 'resize', startX: e.clientX, startY: e.clientY, startW: rb.offsetWidth, startH: rb.offsetHeight };
        return e.preventDefault(), e.stopPropagation();
      }
      const header = e.target.closest('.region-header');
      if (header) {
        const rb = header.closest('.region-box');
        const offset = Utils.calcRectOffset(e.clientX, e.clientY, rb.getBoundingClientRect());
        regionDragId = rb.dataset.regionId;
        this.regionDrag = { id: regionDragId, type: 'move', offsetX: offset.x, offsetY: offset.y };
        return e.preventDefault(), e.stopPropagation();
      }
      
      RegionManager.startDrawing(e);
    },

    async handleMouseMove(e) {
      if (this.ticking) return;
      this.ticking = true;
      
      requestAnimationFrame(async () => {
        if (this.imgDrag.id) {
          const pageId = meta.pageOrder[currentP];
          const offsetX = e.clientX - this.imgDrag.offsetX;
          const offsetY = e.clientY - this.imgDrag.offsetY;
          ImageManager.updateImage(this.imgDrag.id, { pageId, left: offsetX, top: offsetY });
        } else if (this.regionDrag.id) {
          const rData = meta.regions.find(r => r.id === this.regionDrag.id);
          if (rData) {
            const pageId = meta.pageOrder[currentP];
            const offsetX = e.clientX - this.regionDrag.offsetX;
            const offsetY = e.clientY - this.regionDrag.offsetY;
            rData.surfaceId = pageId;
            rData.x = offsetX; 
            rData.y = offsetY;
            StorageManager.requestSave();
          }
        } else {
          RegionManager.draw(e);
        }
        this.ticking = false;
      });
    },

    async handleMouseUp(e) {
      if (this.imgDrag.id) {
        imgDragId = null;
        this.imgDrag.id = null;
        await StorageManager.executeSave();
      } else if (this.regionDrag.id) {
        regionDragId = null;
        this.regionDrag.id = null;
        await StorageManager.executeSave();
      } else {
        RegionManager.stopDrawing(e);
      }
    },

    handleKeydown(e) {
      const k = e.key, alt = e.altKey, ctrl = e.ctrlKey, shift = e.shiftKey;
      if (!e.target.classList.contains("bullet-text")) {
        if (k === "ArrowLeft" || k === "ArrowRight") {
          e.preventDefault();
          StateManager.changePage(k === "ArrowLeft" ? -1 : 1).catch(console.error);
        }
        return;
      }
      if (k === "Escape") return e.preventDefault(), e.target.blur();
      const bId = e.target.closest(".bullet-block").dataset.id;
      const cPos = SelectionManager.getCaretPos(e.target);

      if (alt && k === "ArrowLeft") return e.preventDefault(), StateManager.changePage(-1);
      if (alt && (k === "ArrowRight" || k === "Enter")) return e.preventDefault(), StateManager.changePage(1);
      if (ctrl && k === "Enter") return e.preventDefault(), EditorEngine.cycleType(bId);
      if (k === "Enter" && !shift) return e.preventDefault(), EditorEngine.splitBlock(bId, cPos);
      if (k === "Tab") return e.preventDefault(), EditorEngine.indentBlock(bId, shift ? -1 : 1);
      if (k === "Backspace" && cPos === 0) {
        e.preventDefault();
        const c = StateManager.getBlockCoords(bId);
        c.block.type !== "text" ? EditorEngine.setBlockType(bId, "text") : (c.bIdx > 0 && EditorEngine.mergeWithPrevious(bId));
        return;
      }
      if (k === "ArrowUp" || k === "ArrowDown") {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const r = sel.getRangeAt(0).getBoundingClientRect(), elR = e.target.getBoundingClientRect();
        if (k === "ArrowUp" && r.top - elR.top < CONFIG.KEY_JUMP_THRESHOLD) return e.preventDefault(), EditorEngine.navigateVertical(bId, -1);
        if (k === "ArrowDown" && elR.bottom - r.bottom < CONFIG.KEY_JUMP_THRESHOLD) return e.preventDefault(), EditorEngine.navigateVertical(bId, 1);
      }
    },

    handlePaste(e) {
      const items = e.clipboardData?.items;
      let imagePasted = false;
      if (items) {
        for (let item of items) {
          if (item.type.startsWith("image/")) {
            const reader = new FileReader();
            reader.onload = (ev) => {
              if (stickerDrawerOpen || e.target?.closest("#sticker-drawer")) StickerBookManager.saveSticker(ev.target.result);
              else ImageManager.spawn(ev.target.result);
            };
            reader.readAsDataURL(item.getAsFile());
            imagePasted = true;
          }
        }
      }
      if (imagePasted) return e.preventDefault();
    },

    handleDrop(e) {
      try {
        const data = JSON.parse(e.dataTransfer.getData("application/json"));
        if (data?.type === "sticker") return e.preventDefault(), ImageManager.spawn(data.src, e.clientX, e.clientY);
      } catch {}
      if (e.dataTransfer.files?.length) {
        let hasImg = false;
        for (let f of e.dataTransfer.files) {
          if (f.type.startsWith("image/")) {
            hasImg = true;
            const reader = new FileReader();
            reader.onload = (ev) => {
              if (stickerDrawerOpen || e.target?.closest("#sticker-drawer")) StickerBookManager.saveSticker(ev.target.result);
              else ImageManager.spawn(ev.target.result, e.clientX, e.clientY);
            };
            reader.readAsDataURL(f);
          }
        }
        if (hasImg) e.preventDefault();
      }
    },

    handleContextMenu(e) {
      const regionHeader = e.target.closest(".region-header");
      const img = e.target.closest(".draggable-image");
      const sticker = e.target.closest(".sticker-item");
      
      if (regionHeader) {
        e.preventDefault(); e.stopPropagation();
        const id = regionHeader.closest(".region-box").dataset.regionId;
        contextMenuX = e.clientX; contextMenuY = e.clientY;
        contextMenuItems = [
          { label: "🗑️ Delete Region", danger: true, action: async () => {
            const idx = meta.regions.findIndex(r => r.id === id);
            if (idx !== -1) {
              const r = meta.regions.splice(idx, 1)[0];
              delete pages[r.pageId];
              FileSystemAPI.trashJson(`pages/${r.pageId}.json`);
              StateManager.rebuildIndex();
              await StorageManager.executeSave();
            }
          }}
        ];
        contextMenuVisible = true;
      } else if (img) {
        e.preventDefault(); e.stopPropagation();
        const id = img.dataset.imgId;
        const data = meta.placedImages.find(i => i.id === id);
        if (!data) return;
        contextMenuX = e.clientX; contextMenuY = e.clientY;
        contextMenuItems = [
          { label: data.locked ? "🔓 Unlock Position" : "🔒 Lock Position", action: () => ImageManager.updateImage(id, { locked: !data.locked }) },
          { label: "🔄 Rotate 45°", action: () => ImageManager.updateImage(id, { rotation: ((data.rotation || 0) + 45) % 360 }) },
          { label: "🔼 Bring Forward", action: () => ImageManager.updateImage(id, { layerBucket: Utils.getNextLayer(data.layerBucket || 'sticker', 1) }) },
          { label: "🔽 Send Backward", action: () => ImageManager.updateImage(id, { layerBucket: Utils.getNextLayer(data.layerBucket || 'sticker', -1) }) },
          { label: "👻 Change Opacity", action: () => ImageManager.updateImage(id, { opacity: Utils.getNextOpacity(data.opacity) }) },
          { label: "🗑️ Delete Image", danger: true, action: () => ImageManager.removeImage(id) }
        ];
        contextMenuVisible = true;
      } else if (sticker) {
        e.preventDefault(); e.stopPropagation();
        const id = sticker.dataset.stickerId;
        contextMenuX = e.clientX; contextMenuY = e.clientY;
        contextMenuItems = [
          { label: "🗑️ Delete Sticker", danger: true, action: () => StickerBookManager.removeSticker(id) }
        ];
        contextMenuVisible = true;
      }
    },

    async handleDblClick(e) {
      const imgEl = e.target.closest(".draggable-image");
      if (imgEl) {
        const id = imgEl.dataset.imgId;
        const file = await FileSystemAPI.readJson(`images/${id}.json`);
        if (file) StickerBookManager.saveSticker(file.src);
        
        zoomedImgId = id; // Trigger zoom!
        setTimeout(() => zoomedImgId = null, 200); // Revert zoom!
      }
    },

    handleDragStart(e) {
      const block = e.target.closest(".bullet-block");
      if (block?.getAttribute("draggable") === "true") {
        this.draggedId = block.dataset.id;
        blockDraggingId = this.draggedId;
      } else if (e.target.closest(".sticker-item")) {
        return; 
      } else {
        e.preventDefault();
      }
    },

    handleDragOver(e) {
      e.preventDefault();
      if (!this.draggedId) return; 

      const target = e.target.closest(".bullet-block");
      if (target && target.dataset.id !== this.draggedId) {
        const rect = target.getBoundingClientRect(), el = blockElements[this.draggedId];
        target.parentNode.insertBefore(el, e.clientY > rect.top + rect.height / 2 ? target.nextSibling : target);
      }
    },

    handleDragEnd() {
      const el = blockElements[this.draggedId];
      if (el) {
        const prev = el.previousElementSibling, next = el.nextElementSibling, list = el.closest(".bujo-list");
        if (list) prev ? StateManager.moveBlockDOM(this.draggedId, prev.dataset.id, true) : next && StateManager.moveBlockDOM(this.draggedId, next.dataset.id, false);
      }
      this.draggedId = null;
      blockDraggingId = null;
    }
  };

  let scrubTimeout;
  function indicatorScrub(e, ind) {
    const r = ind.getBoundingClientRect(), pC = meta.pageOrder.length;
    if (pC <= 1) return;
    const idx = Utils.clamp(Math.floor((Utils.clamp(e.clientX - r.left, 0, r.width) / r.width) * pC), 0, pC - 1);
    if (currentP !== idx) {    // changed line
      currentP = idx;
      clearTimeout(scrubTimeout);
      scrubTimeout = setTimeout(() => {
        StateManager.changePage(idx, false);
      }, 50);
    }
  }

  // ==========================================
  // 9. APP INITIALIZATION
  // ==========================================
  onMount(async () => {
    let isDestroyed = false;
    
    const initialize = async () => {
      await StateManager.init();
      if (isDestroyed) return;
      StickerBookManager.render();
      ImageManager.restoreAll();
      EventController.init();
      
      // Wait for DOM to settle, then set initial text
      await tick();
      for (const id in blockTexts) {
        EditorEngine.setBlockTextContent(id);
      }
    };

    initialize();
      window.addEventListener('beforeunload', () => {
        if (StorageManager.saveTimeout) {
          clearTimeout(StorageManager.saveTimeout);
          StorageManager.executeSave();
        }
      });

    return () => {
      isDestroyed = true;
      EventController.destroy();
    };
  });
</script>

<style>
  :global(body) { overflow-x: hidden; overflow-y: auto; background-color: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  :global([contenteditable]:empty::before) { content: "\FEFF"; }

  .bullet-block { animation: slideIn 0.15s ease-out forwards; cursor: default; }
  @keyframes slideIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  :global(::-webkit-scrollbar) { display: none; }
  .bullet-handle { cursor: grab; user-select: none; }
  .bullet-handle:active { cursor: grabbing; }
  .dragging { opacity: 0.3; }
  .bullet-text { cursor: text; user-select: text; word-break: break-word; -webkit-hyphens: auto; hyphens: auto; }
  .region-content::-webkit-scrollbar { display: none; }

  .draggable-image { position: absolute; top: 0; left: 0; cursor: grab; max-width: 300px; filter: drop-shadow(0px 8px 12px rgba(0, 0, 0, 0.15)); user-select: none; transition: scale 0.2s ease, rotate 0.2s ease, opacity 0.2s ease; }
  .draggable-image:active { cursor: grabbing; }
  .draggable-image[data-locked="true"] { cursor: default; }
  .draggable-image[data-locked="true"]:active { cursor: default; }
  :global(.layer-background) { z-index: 10; }
  :global(.layer-paper) { z-index: 20; }
  :global(.layer-sticker) { z-index: 30; }
  :global(.layer-floating) { z-index: 40; }
  :global(.layer-focus) { z-index: 50; }
</style>

<!-- UI -->
<button 
  id="sticker-toggle" 
  class="fixed top-6 right-6 w-12 h-12 bg-white rounded-full shadow-lg text-2xl z-[60] hover:scale-110 transition-transform flex items-center justify-center border border-zinc-100"
  onclick={() => stickerDrawerOpen = !stickerDrawerOpen}
>🎒</button>

<div 
  id="sticker-drawer" 
  class="fixed top-0 right-0 w-80 h-screen bg-zinc-50 shadow-2xl z-[50] transform transition-transform duration-300 ease-out border-l border-zinc-200 p-6 overflow-y-auto {stickerDrawerOpen ? 'translate-x-0' : 'translate-x-full'}"
>
  <h2 class="text-2xl font-bold mb-2 mt-16 text-zinc-800">Stickers 🌟</h2>
  <p class="text-xs text-zinc-500 mb-6 leading-relaxed">Double-click any floating image on your page to save it here! Or upload new ones directly 👇</p>
  <label class="block w-full cursor-pointer bg-zinc-800 text-white hover:bg-zinc-700 text-center py-3 rounded-lg font-semibold text-sm mb-6 transition-colors shadow-md">
    ➕ Upload Sticker
    <input type="file" id="sticker-upload" accept="image/*" class="hidden" onchange={(e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => StickerBookManager.saveSticker(ev.target.result);
      reader.readAsDataURL(file);
    }} />
  </label>
  <div id="sticker-grid" class="grid grid-cols-2 gap-4">
    {#if loadedStickers.length === 0}
      <div class="col-span-2 text-center text-sm text-zinc-400 mt-4">No stickers saved yet! 😿</div>
    {:else}
      {#each loadedStickers as s (s.id)}
        <div 
          class="sticker-item cursor-pointer group flex items-center justify-center p-2 bg-white rounded-lg shadow-sm border border-zinc-100 hover:shadow-md hover:-translate-y-1 transition-all"
          data-sticker-id={s.id}
          draggable="true"
          ondragstart={(e) => e.dataTransfer.setData("application/json", JSON.stringify({ type: "sticker", src: s.src }))}
          onclick={() => ImageManager.spawn(s.src)}
          oncontextmenu={(e) => EventController.handleContextMenu(e)}
        >
          <img src={s.src} draggable="false" class="max-w-full max-h-24 object-contain filter drop-shadow-sm group-hover:drop-shadow-md" alt="sticker">
        </div>
      {/each}
    {/if}
  </div>
</div>

<div 
  id="app" 
  class="flex w-full min-h-screen will-change-transform relative items-start {isScrubbing ? '!transition-none' : 'transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]'}" 
  style="transform: translateX(-{currentP * 100}vw)"
>
  {#each meta.pageOrder as pId, i (pId)}
    <div 
      class="page-wrapper w-[100vw] min-h-screen flex-shrink-0 relative flex justify-center overflow-hidden" 
      data-page-id={pId}
      bind:this={pageWrappers[pId]}
      onmousedown={(e) => EventController.handleMouseDown(e)}
      ondblclick={(e) => EventController.handleDblClick(e)}
      oncontextmenu={(e) => EventController.handleContextMenu(e)}
    >
      <div class="absolute bottom-8 left-0 w-full text-center text-zinc-400 text-sm font-mono tracking-widest select-none pointer-events-none">{i + 1}</div>
      
      <!-- Regions -->
      {#each meta.regions.filter(r => r.surfaceId === pId) as r (r.id)}
        <div 
          class="region-box absolute bg-transparent hover:bg-white/40 border border-transparent hover:border-zinc-200 transition-colors duration-300 rounded-lg flex flex-col layer-paper"
          data-region-id={r.id}
          data-page-id={r.pageId}
          style="left: {r.x}px; top: {r.y}px; width: {r.width}px; height: {r.height}px"
        >
          <div class="region-header h-5 bg-transparent cursor-grab active:cursor-grabbing rounded-t-lg flex items-center px-2 hover:bg-black/5 transition-colors group"></div>
          <div class="region-content flex-1 overflow-y-auto py-4 pr-4 pl-10 cursor-text" style="touch-action: pan-y;">
            <div 
              class="bujo-list min-h-full" 
              data-region-page-id={r.pageId}
              ondragover={(e) => EventController.handleDragOver(e)}
              ondragend={(e) => EventController.handleDragEnd(e)}
            >
              {#if pages[r.pageId]}
                {#each pages[r.pageId] as b (b.id)}
                  <div 
                    class="relative flex items-start mb-2 bullet-block group {blockDraggingId === b.id ? 'dragging' : ''}" 
                    data-id={b.id} 
                    bind:this={blockElements[b.id]} 
                    style="margin-left: {b.depth * CONFIG.INDENT_PX}px"
                    draggable={blockDraggingId === b.id ? "true" : "false"}
                    ondragstart={(e) => EventController.handleDragStart(e)}
                  >
                    <div class={Utils.getHandleClasses(CONFIG.CYCLE.includes(b.type))} draggable="false">
                      {CONFIG.CYCLE.includes(b.type) ? CONFIG.BULLETS[b.type] : "::"}
                    </div>
                    <div 
                      class={Utils.getBlockClasses(b.type)} 
                      contenteditable="true" 
                      spellcheck="false"
                      bind:this={blockTexts[b.id]}
                      onkeydown={(e) => EventController.handleKeydown(e)}
                      oninput={(e) => EditorEngine.updateText(b.id, e.target.innerText)}
                    >
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
          <div class="region-resizer absolute bottom-0 right-0 w-5 h-5 cursor-se-resize flex items-end justify-end p-1 opacity-0 hover:opacity-100 transition-opacity">
            <div class="w-2 h-2 border-r-2 border-b-2 border-zinc-400 rounded-sm pointer-events-none"></div>
          </div>
        </div>
      {/each}

      <!-- Temp Region (while drawing) -->
      {#if isDrawingRegion && tempRegion.surfaceId === pId}
        <div 
          class="absolute border border-zinc-400 bg-white/20 rounded-lg pointer-events-none layer-focus"
          style="left: {tempRegion.x}px; top: {tempRegion.y}px; width: {tempRegion.w}px; height: {tempRegion.h}px"
        ></div>
      {/if}

      <!-- Images -->
      {#each meta.placedImages.filter(img => img.pageId === pId) as img (img.id)}
        {#if loadedImages[img.id]}
          <img 
            src={loadedImages[img.id]}
            class="draggable-image layer-{img.layerBucket || 'sticker'} transition-transform duration-200 {zoomedImgId === img.id ? 'scale-125' : 'scale-100'}"            data-img-id={img.id}
            data-page-id={img.pageId}
            data-locked={img.locked ? "true" : null}
            alt="placed"
            style="left: {img.left}px; top: {img.top}px; rotate: {img.rotation || 0}deg; opacity: {img.opacity ?? 1}; {imgDragId === img.id ? 'pointer-events: none; z-index: 100; transition: none;' : ''}"
          />
        {/if}
      {/each}
    </div>
  {/each}
</div>

<div 
  id="page-indicator" 
  class="fixed bottom-2 left-1/2 -translate-x-1/2 flex gap-3 z-50 p-4 cursor-grab active:cursor-grabbing touch-none"
  onpointerdown={(e) => {
    const ind = e.currentTarget;
    ind.setPointerCapture(e.pointerId);
    ind._isScrubbing = true;
    isScrubbing = true; // ✨ SVELTE WAY
    indicatorScrub(e, ind);
  }}
  onpointermove={(e) => {
    const ind = e.currentTarget;
    if (ind._isScrubbing) indicatorScrub(e, ind);
  }}
  onpointerup={async (e) => {
    const ind = e.currentTarget;
    ind._isScrubbing = false;
    isScrubbing = false; // ✨ SVELTE WAY
    ind.releasePointerCapture(e.pointerId);
    await StorageManager.executeSave();
  }}
  onclick={(e) => {
    const dot = e.target.closest(".indicator-dot");
    if (dot) StateManager.changePage(parseInt(dot.dataset.idx), false);
  }}
>
  {#each meta.pageOrder as _, i}
    <span 
      data-idx={i} 
      class="indicator-dot pointer-events-none h-2 rounded-full transition-all duration-300 {i === currentP ? 'w-6 bg-zinc-800' : 'w-2 bg-zinc-300 hover:bg-zinc-400'}"
    ></span>
  {/each}
</div>

{#if contextMenuVisible}
  <div 
    id="custom-context-menu" 
    class="fixed bg-white border border-zinc-200 shadow-xl rounded-md py-1 z-[100] w-48"
    style="left: {contextMenuX}px; top: {contextMenuY}px"
  >
    {#each contextMenuItems as item}
      <button 
        class="w-full text-left px-3 py-1.5 hover:bg-zinc-100 text-sm {item.danger ? 'text-red-600' : 'text-zinc-800'}"
        onclick={(e) => {
          e.stopPropagation();
          item.action();
          contextMenuVisible = false;
        }}
      >
        {item.label}
      </button>
    {/each}
  </div>
{/if}
