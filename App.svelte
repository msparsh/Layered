<script>
  import { onMount, tick } from "svelte";

  // Svelte state variables
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
  let blockDraggingId = $state(null);

  let activeFocusId = $state(null);
  let activeCursorOffset = $state(0);

  // ==========================================
  // 1. CONSTANTS & CONFIGURATION
  // ==========================================
  const CONFIG = {
    BULLETS: { task: "•", completed: "✕", migrated: ">", scheduled: "<", event: "○", note: "-" },
    CYCLE: ["task", "completed", "migrated", "scheduled", "event", "note"],
    MD_MAP: {
      "* ": "task",
      "x ": "completed",
      "> ": "migrated",
      "< ": "scheduled",
      "o ": "event",
      "- ": "note",
      "# ": "h1",
      "## ": "h2",
      "### ": "h3",
      "#### ": "h4",
      "##### ": "h5",
      "###### ": "h6",
    },
    H_STYLES: {
      h1: "text-4xl font-bold mt-6 mb-2",
      h2: "text-3xl font-bold mt-5 mb-2",
      h3: "text-2xl font-bold mt-4 mb-1",
      h4: "text-xl font-semibold mt-3 mb-1",
      h5: "text-lg font-semibold mt-2 mb-1",
      h6: "text-base font-semibold uppercase tracking-wider mt-2 mb-1 text-zinc-500",
    },
    SAVE_TIMEOUT_MS: 500,
    LAYERS: ["background", "paper", "sticker", "floating", "focus"],
    OPACITIES: [1, 0.75, 0.5, 0.25],
    INDENT_PX: 28,
    MIN_REGION_SIZE: 50,
    KEY_JUMP_THRESHOLD: 24,
    MAX_DEPTH: 4,
  };

  const DOM_IDS = {
    APP: "app",
    INDICATOR: "page-indicator",
    STICKER_TOGGLE: "sticker-toggle",
    STICKER_DRAWER: "sticker-drawer",
    STICKER_UPLOAD: "sticker-upload",
    STICKER_GRID: "sticker-grid",
    CONTEXT_MENU: "custom-context-menu",
  };

  // ==========================================
  // 2. IN-FILE REACTIVE STORE 🧠
  // ==========================================
  class BujoStore {
    // ✨ Reactive State Properties
    meta = $state({ pageOrder: [], stickers: [], placedImages: [], regions: [] });
    pages = $state({});
    currentP = $state(0);
    loadedImages = $state({});

    // 🔒 Internal Class Properties (Not reactive in the DOM, just for logic)
    blockMap = new Map();
    dirtyPages = new Set();
    isSaving = false;
    needsSave = false;
    saveTimeout = null;

    // ----------------------------------------
    // 💾 STORAGE & INIT METHODS
    // ----------------------------------------
    async init() {
      const loadedMeta = (await FileSystemAPI.readJson("meta.json")) || {};
      const m = { version: 4, currentP: 0, pageOrder: [], scrolls: [], stickers: [], placedImages: [], regions: [], lines: [], ...loadedMeta };

      if (m.pageOrder.length === 0) {
        m.pageOrder.push(`page-${Utils.generateId()}`, `page-${Utils.generateId()}`);
        await FileSystemAPI.writeJsonAtomic("meta.json", m);
      }

      this.meta = m;
      this.currentP = this.meta.currentP || 0;

      await Promise.all(
        this.meta.regions.map(async (r) => {
          if (!this.pages[r.pageId]) {
            this.pages[r.pageId] = (await FileSystemAPI.readJson(`pages/${r.pageId}.json`)) || [this.createBlock()];
          }
        }),
      );
      this.rebuildIndex();
    }

    requestSave(forceRender = false) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(() => this.executeSave(forceRender), CONFIG.SAVE_TIMEOUT_MS);
    }

    async executeSave(forceRender = false) {
      if (this.isSaving) return (this.needsSave = true);

      this.isSaving = true;
      this.needsSave = false;

      try {
        await this.cleanEmptySpreads();
        this.meta.currentP = this.currentP;

        // 🌟 Snapshot before sending to Electron!
        const pureMeta = $state.snapshot(this.meta);
        await FileSystemAPI.writeJsonAtomic("meta.json", pureMeta);

        const pagesToSave = new Set(this.dirtyPages);
        this.dirtyPages.clear();

        for (const pageId of pagesToSave) {
          if (this.pages[pageId]) {
            const purePage = $state.snapshot(this.pages[pageId]);
            await FileSystemAPI.writeJsonAtomic(`pages/${pageId}.json`, purePage);
          }
        }
      } catch (error) {
        console.error("Failed to save! 😿", error);
      } finally {
        this.isSaving = false;
        if (this.needsSave) this.executeSave(); // Catch up if a save was requested mid-save
      }
    }

    // ----------------------------------------
    // 📝 STATE MANAGER METHODS (Blocks & Pages)
    // ----------------------------------------
    createBlock(text = "", depth = 0, type = "text") {
      return { id: Utils.generateId(), type, text, depth };
    }

    rebuildIndex() {
      this.blockMap.clear();
      Object.entries(this.pages).forEach(([pageId, pageBlocks]) => {
        pageBlocks.forEach((block, bIdx) => this.blockMap.set(block.id, { pageId, bIdx, block }));
      });
    }

    getBlockCoords(id) {
      return this.blockMap.get(id) || null;
    }

    async cleanEmptySpreads() {
      let changed = false;
      while (this.meta.pageOrder.length > 1 && this.meta.pageOrder.length - 1 !== this.currentP) {
        const i = this.meta.pageOrder.length - 1;
        const pId = this.meta.pageOrder[i];

        const isEmpty = (surfaceId) => !this.meta.placedImages.some((img) => img.pageId === surfaceId) && !this.meta.regions.some((r) => r.surfaceId === surfaceId);

        if (isEmpty(pId)) {
          delete this.pages[pId];
          this.meta.pageOrder.splice(i, 1);
          if (this.meta.scrolls) this.meta.scrolls.splice(i, 1);
          changed = true;
        } else break;
      }

      if (this.currentP >= this.meta.pageOrder.length) {
        this.currentP = Math.max(0, this.meta.pageOrder.length - 1);
        changed = true;
      }

      if (changed) this.rebuildIndex();
      return changed;
    }

    async ensureEnoughPages() {
      if (this.currentP >= this.meta.pageOrder.length) {
        const newPageId = `page-${Utils.generateId()}`;
        this.meta.pageOrder.push(newPageId);
        this.rebuildIndex();
        await FileSystemAPI.writeJsonAtomic("meta.json", $state.snapshot(this.meta));
        return true;
      }
      return false;
    }

    updateBlock(id, updates) {
      const c = this.getBlockCoords(id);
      if (c) {
        Object.assign(c.block, updates);
        this.dirtyPages.add(c.pageId);
        this.requestSave();
      }
    }

    addBlock(newBlock, idAfter) {
      const c = this.getBlockCoords(idAfter);
      if (!c) return;
      this.pages[c.pageId].splice(c.bIdx + 1, 0, newBlock);
      this.rebuildIndex();
      this.dirtyPages.add(c.pageId);
      this.requestSave();
    }

    removeBlock(id) {
      const c = this.getBlockCoords(id);
      if (!c) return;
      this.pages[c.pageId].splice(c.bIdx, 1);
      this.rebuildIndex();
      this.dirtyPages.add(c.pageId);
      this.requestSave();
    }

    moveBlockDOM(id, targetId, insertAfter) {
      const src = this.getBlockCoords(id);
      const tgt = this.getBlockCoords(targetId);
      if (!src || !tgt) return;

      const [moved] = this.pages[src.pageId].splice(src.bIdx, 1);
      const sameArray = src.pageId === tgt.pageId;
      let iIdx = tgt.bIdx - (sameArray && src.bIdx < tgt.bIdx ? 1 : 0) + (insertAfter ? 1 : 0);

      this.pages[tgt.pageId].splice(iIdx, 0, moved);
      this.rebuildIndex();

      this.dirtyPages.add(src.pageId);
      if (!sameArray) this.dirtyPages.add(tgt.pageId);
      this.requestSave();
    }

    async changePage(dirOrIdx, isRelative = true) {
      const nextP = isRelative ? this.currentP + dirOrIdx : dirOrIdx;
      if (nextP < 0) return;
      this.currentP = nextP;
      await this.ensureEnoughPages();
      window.scrollTo({ top: 0, behavior: "smooth" });
      await this.executeSave();
    }

    // ----------------------------------------
    // 🖼️ IMAGE MANAGER METHODS
    // ----------------------------------------
    async spawnImage(src, clientX, clientY) {
      const id = Utils.generateId();
      await FileSystemAPI.writeJsonAtomic(`images/${id}.json`, { src });

      let left = 100,
        top = 100;
      let pageId = this.meta.pageOrder[this.currentP];

      if (clientX !== undefined && clientY !== undefined) {
        left = clientX - 50;
        top = clientY - 50;
      }

      const imgData = { id, pageId, left, top, layerBucket: "sticker" };
      this.meta.placedImages.push(imgData);
      await this.executeSave();
      this.renderImage(imgData);
    }

    async renderImage(data) {
      const file = await FileSystemAPI.readJson(`images/${data.id}.json`);
      if (file && file.src) {
        this.loadedImages[data.id] = file.src; // Triggers UI update! 🎉
      }
    }

    updateImage(id, updates) {
      const imgData = this.meta.placedImages.find((i) => i.id === id);
      if (!imgData) return;
      Object.assign(imgData, updates);
      this.requestSave();
    }

    restoreAllImages() {
      this.meta.placedImages.forEach((data) => this.renderImage(data));
    }

    async removeImage(id) {
      const idx = this.meta.placedImages.findIndex((i) => i.id === id);
      if (idx !== -1) {
        this.meta.placedImages.splice(idx, 1);
        await this.executeSave();
        delete this.loadedImages[id];
        FileSystemAPI.trashJson(`images/${id}.json`);
      }
    }
  }

  // 🚀 Instantiate the store globally for the component
  const store = new BujoStore();

  // ==========================================
  // 2. ISOLATED ACTIONS 🏗️
  // ==========================================

  // 🌟 Clean pointer actions!
  function pointerAction(node, { onDown, onMove, onUp, ignore }) {
    let active = false;
    const down = (e) => {
      if (e.button !== 0 || (ignore && ignore(e))) return;
      active = true;
      node.setPointerCapture(e.pointerId);
      if (onDown) onDown(e);
    };
    const move = (e) => { if (active && onMove) onMove(e); };
    const up = (e) => {
      if (!active) return;
      active = false;
      node.releasePointerCapture(e.pointerId);
      if (onUp) onUp(e);
    };
    const evts = ["pointerdown", "pointermove", "pointerup", "pointercancel"];
    const handlers = [down, move, up, up];
    evts.forEach((ev, i) => node.addEventListener(ev, handlers[i]));
    return { destroy() { evts.forEach((ev, i) => node.removeEventListener(ev, handlers[i])); } };
  }

  function draggableImage(node, imgData) {
    let sX, sY, iL, iT;
    return pointerAction(node, {
      ignore: () => imgData.locked,
      onDown: (e) => { sX = e.clientX; sY = e.clientY; iL = imgData.left; iT = imgData.top; e.preventDefault(); e.stopPropagation(); },
      onMove: (e) => { imgData.left = iL + (e.clientX - sX); imgData.top = iT + (e.clientY - sY); },
      onUp: () => store.requestSave()
    });
  }

  function draggableRegion(node, regionId) {
    let sX, sY, iX, iY;
    return pointerAction(node, {
      onDown: (e) => {
        const r = store.meta.regions.find(r => r.id === regionId);
        if (!r) return;
        sX = e.clientX; sY = e.clientY; iX = r.x; iY = r.y; e.preventDefault(); e.stopPropagation();
      },
      onMove: (e) => {
        const r = store.meta.regions.find(r => r.id === regionId);
        if (r) { r.x = iX + (e.clientX - sX); r.y = iY + (e.clientY - sY); }
      },
      onUp: () => store.requestSave()
    });
  }

  function resizableRegion(node, regionId) {
    let sX, sY, iW, iH;
    return pointerAction(node, {
      onDown: (e) => {
        const r = store.meta.regions.find(r => r.id === regionId);
        if (!r) return;
        sX = e.clientX; sY = e.clientY; iW = r.width; iH = r.height; e.preventDefault(); e.stopPropagation();
      },
      onMove: (e) => {
        const r = store.meta.regions.find(r => r.id === regionId);
        if (r) { r.width = Math.max(CONFIG.MIN_REGION_SIZE, iW + (e.clientX - sX)); r.height = Math.max(CONFIG.MIN_REGION_SIZE, iH + (e.clientY - sY)); }
      },
      onUp: () => store.requestSave()
    });
  }

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
      return wrappers.find((w) => w && this.isBetweenHorizontally(clientX, w.getBoundingClientRect())) || wrappers[0];
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
    qsa: (selector) => document.querySelectorAll(selector),
  };

  // ==========================================
  // 4. DATA STORAGE
  // ==========================================
  const api = window.electronAPI;
  const memFs = new Map();

  const FileSystemAPI = {
    readJson: async (path) => (api ? await api.readJson(path) : (memFs.get(path) ?? null)),
    writeJsonAtomic: async (path, data) => (api ? await api.writeJsonAtomic(path, data) : memFs.set(path, data)),
    trashJson: async (path) => (api ? await api.trashJson(path) : memFs.delete(path)),
  };

  // ==========================================
  // 5. STATE MANAGEMENT
  // ==========================================

  // ==========================================
  // CORE MANAGERS (Listening to Events)
  // ==========================================

  // ==========================================
  // 5. CORE MANAGERS (Updated for BujoStore!) 🚀
  // ==========================================

  const StickerBookManager = {
    async saveSticker(base64Src) {
      const id = Utils.generateId();
      await FileSystemAPI.writeJsonAtomic(`images/sticker-${id}.json`, { src: base64Src });
      store.meta.stickers.push(id); // ✨ Now uses store
      await store.executeSave();
      this.render();
    },
    async removeSticker(id) {
      const idx = store.meta.stickers.indexOf(id);
      if (idx !== -1) {
        store.meta.stickers.splice(idx, 1); // ✨ Now uses store
        await store.executeSave();
        this.render();
        await FileSystemAPI.trashJson(`images/sticker-${id}.json`);
      }
    },
    async render() {
      const promises = store.meta.stickers.map(async (id) => {
        const file = await FileSystemAPI.readJson(`images/sticker-${id}.json`);
        return file ? { id, src: file.src } : null;
      });
      loadedStickers = (await Promise.all(promises)).filter(Boolean);
    },
  };

  const RegionManager = {
    startX: 0,
    startY: 0,
    surfaceId: null,

    startDrawing(e) {
      const wrapper = e.target.closest(".page-wrapper");
      if (!wrapper) return;

      isDrawingRegion = true;
      this.surfaceId = wrapper.dataset.pageId;
      const offset = Utils.calcRectOffset(e.clientX, e.clientY, wrapper.getBoundingClientRect());
      this.startX = offset.x;
      this.startY = offset.y;

      // ✨ Force Svelte 5 reactivity with a fresh object!
      tempRegion = { x: this.startX, y: this.startY, w: 0, h: 0, surfaceId: this.surfaceId };
    },

    draw(e) {
      if (!isDrawingRegion) return;
      const wrapper = Array.from(Utils.qsa(".page-wrapper")).find((w) => w.dataset.pageId === this.surfaceId);
      if (!wrapper) return;

      const offset = Utils.calcRectOffset(e.clientX, e.clientY, wrapper.getBoundingClientRect());

      // ✨ Force UI update by reassigning instead of mutating!
      tempRegion = {
        ...tempRegion,
        x: Math.min(this.startX, offset.x),
        y: Math.min(this.startY, offset.y),
        w: Math.abs(offset.x - this.startX),
        h: Math.abs(offset.y - this.startY),
      };
    },

    async stopDrawing(e) {
      if (!isDrawingRegion) return;
      isDrawingRegion = false;

      if (tempRegion.w > CONFIG.MIN_REGION_SIZE && tempRegion.h > CONFIG.MIN_REGION_SIZE) {
        const regionId = Utils.generateId();
        const pageId = `page-${Utils.generateId()}`;
        const region = { id: regionId, surfaceId: this.surfaceId, x: tempRegion.x, y: tempRegion.y, width: tempRegion.w, height: tempRegion.h, pageId };

        // ✨ Bulletproof Array Update (Forces UI to render the new region)
        store.meta.regions = [...store.meta.regions, region];

        const newBlock = store.createBlock();

        // ✨ Bulletproof Object Update
        store.pages = { ...store.pages, [pageId]: [newBlock] };

        store.rebuildIndex();
        store.dirtyPages.add(pageId);
        await store.executeSave();

        activeFocusId = newBlock.id;
        activeCursorOffset = 0;
      }
    },
  };
  const EditorEngine = {
    setBlockType(id, type) {
      store.updateBlock(id, { type });
    }, // ✨ Now uses store
    indentBlock(id, dir) {
      const c = store.getBlockCoords(id);
      if (c) store.updateBlock(id, { depth: Utils.clamp(c.block.depth + dir, 0, CONFIG.MAX_DEPTH) });
    },
    updateText(id, currentText) {
      const coords = store.getBlockCoords(id);
      if (!coords) return;
      let processedText = currentText.replace(/\u00A0/g, " ");
      let newType = coords.block.type;
      let isMarkdownTriggered = false;

      for (const [prefix, t] of Object.entries(CONFIG.MD_MAP)) {
        if (processedText.startsWith(prefix)) {
          newType = t;
          processedText = processedText.substring(prefix.length);
          isMarkdownTriggered = true;
          break;
        }
      }

      if (isMarkdownTriggered) {
        store.updateBlock(id, { text: processedText, type: newType });
        activeFocusId = id; // 🎯 Fixed reference error!
        activeCursorOffset = 0;
      } else {
        store.updateBlock(id, { text: currentText });
      }
    },
    cycleType(id) {
      const c = store.getBlockCoords(id);
      if (c) this.setBlockType(id, Utils.getNextType(c.block.type));
    },
    splitBlock(id, caretPos) {
      const c = store.getBlockCoords(id);
      if (!c) return;
      const { block } = c;
      const newType = block.type.startsWith("h") ? "text" : block.type;
      const newBlock = store.createBlock(block.text.slice(caretPos), block.depth, newType);

      store.updateBlock(id, { text: block.text.slice(0, caretPos) });
      store.addBlock(newBlock, id);
      activeFocusId = newBlock.id; // 🎯 Fixed reference error!
      activeCursorOffset = 0;
    },
    mergeWithPrevious(id) {
      const c = store.getBlockCoords(id);
      if (!c || c.bIdx === 0) return;

      const prev = store.pages[c.pageId][c.bIdx - 1]; // ✨ Now uses store
      const mergePoint = prev.text.length;
      const merged = prev.text + c.block.text;

      store.updateBlock(prev.id, { text: merged });
      store.removeBlock(id);
      activeFocusId = prev.id; // 🎯 Fixed reference error!
      activeCursorOffset = mergePoint;
    },
    navigateVertical(id, dir) {
      const c = store.getBlockCoords(id);
      if (!c) return;
      const targetBlock = store.pages[c.pageId][c.bIdx + dir]; // ✨ Now uses store
      if (targetBlock) {
        activeFocusId = targetBlock.id; // 🎯 Fixed reference error!
        activeCursorOffset = 0;
      }
    },
  };

  // ==========================================
  // 8. EVENT CONTROLLER
  // ==========================================
  let scrubTimeout;
  function indicatorScrub(e, ind) {
    const r = ind.getBoundingClientRect(),
      pC = store.meta.pageOrder.length;
    if (pC <= 1) return;
    const idx = Utils.clamp(Math.floor((Utils.clamp(e.clientX - r.left, 0, r.width) / r.width) * pC), 0, pC - 1);
    if (store.currentP !== idx) {
      // changed line
      store.currentP = idx;
      clearTimeout(scrubTimeout);
      scrubTimeout = setTimeout(() => {
        store.changePage(idx, false);
      }, 50);
    }
  }

  function autoResize(node, text) {
    const resize = () => {
      node.style.height = "auto";
      node.style.height = node.scrollHeight + "px";
    };

    node.addEventListener("input", resize);
    setTimeout(resize, 0);

    return {
      update() {
        // Triggers instantly whenever the text bound parameter changes programmatically! 🎉
        resize();
      },
      destroy() {
        node.removeEventListener("input", resize);
      },
    };
  }
  const EventController = {
    handleContextMenu(e) {
      e.preventDefault();
      contextMenuX = e.clientX;
      contextMenuY = e.clientY;
      contextMenuItems = [{ label: "Page Options 📄", action: () => console.log("Wrapper clicked!") }];
      contextMenuVisible = true;
    },
    handleDragStart(e) {
      const id = e.target.closest(".bullet-block")?.dataset?.id;
      if (id) blockDraggingId = id;
    },
    handleDragOver(e) {
      e.preventDefault();
    },
    handleDragEnd(e) {
      blockDraggingId = null;
    },
    handleKeydown(e) {
      const id = e.target.dataset.id;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        EditorEngine.splitBlock(id, e.target.selectionStart);
      }
      if (e.key === "Backspace" && e.target.selectionStart === 0) {
        e.preventDefault();
        EditorEngine.mergeWithPrevious(id);
      }
      if (e.key === "Tab") {
        e.preventDefault();
        EditorEngine.indentBlock(id, e.shiftKey ? -1 : 1);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        EditorEngine.navigateVertical(id, -1);
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        EditorEngine.navigateVertical(id, 1);
      }
    },
    handleDblClick(e) {
      // Add any specific double click logic here if needed!
    },
  };

  // ==========================================
  // 9. APP INITIALIZATION
  // ==========================================
  onMount(async () => {
    let isDestroyed = false;

    const initialize = async () => {
      await store.init(); // ✨ Now uses store
      if (isDestroyed) return;
      StickerBookManager.render();
      store.restoreAllImages(); // ✨ Now uses store
    };

    initialize();
    window.addEventListener("beforeunload", () => {
      if (store.saveTimeout) {
        // ✨ Now uses store
        clearTimeout(store.saveTimeout);
        store.executeSave(); // ✨ Now uses store
      }
    });

    return () => {
      isDestroyed = true;
    };
  });
  function autoFocus(node, { id, focusId, offset }) {
    $effect(() => {
      if (id === focusId) {
        node.focus();
        const targetPos = Math.min(offset, node.value.length);
        node.setSelectionRange(targetPos, targetPos);
        activeFocusId = null; // Reset after firing 🎯
      }
    });
  }
</script>

<svelte:window onclick={() => (contextMenuVisible = false)} />

<!-- UI -->
<button
  id="sticker-toggle"
  class="fixed top-6 right-6 w-12 h-12 bg-white rounded-full shadow-lg text-2xl z-[60] hover:scale-110 transition-transform flex items-center justify-center border border-zinc-100"
  onclick={() => (stickerDrawerOpen = !stickerDrawerOpen)}>🎒</button
>

<div
  id="sticker-drawer"
  class="fixed top-0 right-0 w-80 h-screen bg-zinc-50 shadow-2xl z-[50] transform transition-transform duration-300 ease-out border-l border-zinc-200 p-6 overflow-y-auto {stickerDrawerOpen
    ? 'translate-x-0'
    : 'translate-x-full'}"
>
  <h2 class="text-2xl font-bold mb-2 mt-16 text-zinc-800">Stickers 🌟</h2>
  <p class="text-xs text-zinc-500 mb-6 leading-relaxed">Double-click any floating image on your page to save it here! Or upload new ones directly 👇</p>
  <label class="block w-full cursor-pointer bg-zinc-800 text-white hover:bg-zinc-700 text-center py-3 rounded-lg font-semibold text-sm mb-6 transition-colors shadow-md">
    ➕ Upload Sticker
    <input
      type="file"
      id="sticker-upload"
      accept="image/*"
      class="hidden"
      onchange={(e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => StickerBookManager.saveSticker(ev.target.result);
        reader.readAsDataURL(file);
      }}
    />
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
          onclick={() => store.spawnImage(s.src)}
          oncontextmenu={(e) => EventController.handleContextMenu(e)}
        >
          <img src={s.src} draggable="false" class="max-w-full max-h-24 object-contain filter drop-shadow-sm group-hover:drop-shadow-md" alt="sticker" />
        </div>
      {/each}
    {/if}
  </div>
</div>

<div
  id="app"
  class="flex w-full min-h-screen will-change-transform relative items-start {isScrubbing
    ? '!transition-none'
    : 'transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]'}"
  style="transform: translateX(-{store.currentP * 100}vw)"
>
  {#each store.meta.pageOrder as pId, i (pId)}
    <div
      class="page-wrapper w-[100vw] min-h-screen flex-shrink-0 relative flex justify-center overflow-hidden"
      data-page-id={pId}
      use:pointerAction={{
        ignore: (e) => ["TEXTAREA", "BUTTON"].includes(e.target.tagName) || e.target.classList.contains("bullet-text") || e.target.closest(".region-box") || e.target.closest(".draggable-image") || e.target.closest("#sticker-drawer") || e.target.closest("#page-indicator"),
        onDown: (e) => RegionManager.startDrawing(e),
        onMove: (e) => RegionManager.draw(e),
        onUp: (e) => RegionManager.stopDrawing(e),
      }}
      ondblclick={(e) => EventController.handleDblClick(e)}
      oncontextmenu={(e) => EventController.handleContextMenu(e)}
    >
      <div class="absolute bottom-8 left-0 w-full text-center text-zinc-400 text-sm font-mono tracking-widest select-none pointer-events-none">{i + 1}</div>

      <!-- Regions -->
      {#each store.meta.regions.filter((r) => r.surfaceId === pId) as r (r.id)}
        <div
          class="region-box absolute bg-transparent hover:bg-white/40 border border-transparent hover:border-zinc-200 transition-colors duration-300 rounded-lg flex flex-col layer-paper"
          data-region-id={r.id}
          data-page-id={r.pageId}
          style="left: {r.x}px; top: {r.y}px; width: {r.width}px; height: {r.height}px"
        >
          <div
            use:draggableRegion={r.id}
            class="region-header h-5 bg-transparent cursor-grab active:cursor-grabbing rounded-t-lg flex items-center px-2 hover:bg-black/5 transition-colors group"
          ></div>

          <div class="region-content flex-1 overflow-y-auto py-4 pr-4 pl-10 cursor-text" style="touch-action: pan-y;">
            <div
              class="bujo-list min-h-full"
              data-region-page-id={r.pageId}
              ondragover={(e) => EventController.handleDragOver(e)}
              ondragend={(e) => EventController.handleDragEnd(e)}
              ondrop={(e) => {
                e.preventDefault();
                const draggedId = e.dataTransfer.getData("text/plain");
                const targetBlock = e.target.closest(".bullet-block");

                if (draggedId && targetBlock) {
                  const targetId = targetBlock.dataset.id;
                  const rect = targetBlock.getBoundingClientRect();
                  const insertAfter = e.clientY > rect.top + rect.height / 2;
                  store.moveBlockDOM(draggedId, targetId, insertAfter);
                }
                blockDraggingId = null;
              }}
            >
              {#if store.pages[r.pageId]}
                {#each store.pages[r.pageId] as b (b.id)}
                  <div
                    class="relative flex items-start mb-2 bullet-block group {blockDraggingId === b.id ? 'dragging' : ''}"
                    data-id={b.id}
                    style="margin-left: {b.depth * CONFIG.INDENT_PX}px"
                    draggable={blockDraggingId === b.id ? "true" : "false"}
                    ondragstart={(e) => EventController.handleDragStart(e)}
                  >
                    <div
                      class={Utils.getHandleClasses(CONFIG.CYCLE.includes(b.type))}
                      draggable="true"
                      ondragstart={(e) => {
                        e.dataTransfer.setData("text/plain", b.id);
                        blockDraggingId = b.id;
                      }}
                      ondragend={() => (blockDraggingId = null)}
                    >
                      {CONFIG.CYCLE.includes(b.type) ? CONFIG.BULLETS[b.type] : "::"}
                    </div>
                    <textarea
                      data-id={b.id}
                      use:autoFocus={{ id: b.id, focusId: activeFocusId, offset: activeCursorOffset }}
                      class="{Utils.getBlockClasses(b.type)} resize-none overflow-hidden bg-transparent"
                      rows="1"
                      spellcheck="false"
                      bind:value={b.text}
                      use:autoResize={b.text}
                      onkeydown={(e) => EventController.handleKeydown(e)}
                      oninput={(e) => EditorEngine.updateText(b.id, e.target.value)}
                    ></textarea>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
          <div
            use:resizableRegion={r.id}
            class="region-resizer absolute bottom-0 right-0 w-5 h-5 cursor-se-resize flex items-end justify-end p-1 opacity-0 hover:opacity-100 transition-opacity"
          >
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
      {#each store.meta.placedImages.filter((img) => img.pageId === pId) as img (img.id)}
        {#if store.loadedImages[img.id]}
          <img
            src={store.loadedImages[img.id]}
            oncontextmenu={(e) => {
              e.preventDefault();
              e.stopPropagation(); // 🛡️ Stops the page-wrapper menu from hijacking the click!
              contextMenuX = e.clientX;
              contextMenuY = e.clientY;
              contextMenuItems = [{ label: "Delete Image 🗑️", danger: true, action: () => store.removeImage(img.id) }];
              contextMenuVisible = true;
            }}
            class="draggable-image layer-{img.layerBucket || 'sticker'} transition-transform duration-200 {zoomedImgId === img.id ? 'scale-125' : 'scale-100'}"
            data-img-id={img.id}
            data-page-id={img.pageId}
            data-locked={img.locked ? "true" : null}
            alt="placed"
            style="left: {img.left}px; top: {img.top}px; rotate: {img.rotation || 0}deg; opacity: {img.opacity ?? 1};"
            use:draggableImage={img}
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
    await store.executeSave();
  }}
  onclick={(e) => {
    const dot = e.target.closest(".indicator-dot");
    if (dot) store.changePage(parseInt(dot.dataset.idx), false);
  }}
>
  {#each store.meta.pageOrder as _, i}
    <span
      data-idx={i}
      class="indicator-dot pointer-events-none h-2 rounded-full transition-all duration-300 {i === store.currentP ? 'w-6 bg-zinc-800' : 'w-2 bg-zinc-300 hover:bg-zinc-400'}"
    ></span>
  {/each}
</div>

{#if contextMenuVisible}
  <div id="custom-context-menu" class="fixed bg-white border border-zinc-200 shadow-xl rounded-md py-1 z-[100] w-48" style="left: {contextMenuX}px; top: {contextMenuY}px">
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

<style>
:global(body){overflow-x:hidden;overflow-y:auto;background-color:#fafafa;font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif}:global([contenteditable]:empty::before){content:"\FEFF"}.bullet-block{animation:slideIn 0.15s ease-out forwards;cursor:default}@keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}} :global(::-webkit-scrollbar){display:none}.bullet-handle{cursor:grab;user-select:none}.bullet-handle:active{cursor:grabbing}.dragging{opacity:0.3}.bullet-text{cursor:text;user-select:text;word-break:break-word;-webkit-hyphens:auto;hyphens:auto}.region-content::-webkit-scrollbar{display:none}.draggable-image{position:absolute;top:0;left:0;cursor:grab;max-width:300px;filter:drop-shadow(0px 8px 12px rgba(0, 0, 0, 0.15));user-select:none;transition:scale 0.2s ease, rotate 0.2s ease, opacity 0.2s ease}.draggable-image:active{cursor:grabbing}.draggable-image[data-locked="true"]{cursor:default}.draggable-image[data-locked="true"]:active{cursor:default}:global(.layer-background){z-index:10}:global(.layer-paper){z-index:20}:global(.layer-sticker){z-index:30}:global(.layer-floating){z-index:40}:global(.layer-focus){z-index:50}
</style>
