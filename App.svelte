<script>
  import { onMount, tick } from "svelte";
  let isScrubbing=$state(false),zoomedImgId=$state(null),stickerDrawerOpen=$state(false),loadedStickers=$state([]),contextMenuVisible=$state(false),contextMenuX=$state(0),contextMenuY=$state(0),contextMenuItems=$state([]),isDrawingRegion=$state(false),tempRegion=$state({x:0,y:0,w:0,h:0}),regionDragId=$state(null),blockDraggingId=$state(null),activeFocusId=$state(null),activeCursorOffset=$state(0),focusedRegionId=$state(null),activePackId=$state("all"),promptVisible=$state(false),promptTitle=$state(""),promptValue=$state(""),promptCallback=$state(null),packSelectorVisible=$state(false),packSelectorStickerId=$state(null);
  const CONFIG={BULLETS:{task:"•",completed:"✕",migrated:">",scheduled:"<",event:"○",note:"-"},CYCLE:["task","completed","migrated","scheduled","event","note"],MD_MAP:{"* ":"task","x ":"completed","> ":"migrated","< ":"scheduled","o ":"event","- ":"note","# ":"h1","## ":"h2","### ":"h3","#### ":"h4","##### ":"h5","###### ":"h6"},H_STYLES:{h1:"text-4xl font-bold mt-6 mb-2",h2:"text-3xl font-bold mt-5 mb-2",h3:"text-2xl font-bold mt-4 mb-1",h4:"text-xl font-semibold mt-3 mb-1",h5:"text-lg font-semibold mt-2 mb-1",h6:"text-base font-semibold uppercase tracking-wider mt-2 mb-1 text-zinc-500"},SAVE_TIMEOUT_MS:500,LAYERS:["background","paper","sticker","floating","focus"],OPACITIES:[1,0.75,0.5,0.25],INDENT_PX:28,MIN_REGION_SIZE:50,KEY_JUMP_THRESHOLD:24,MAX_DEPTH:4};
  const DOM_IDS={APP:"app",INDICATOR:"page-indicator",STICKER_TOGGLE:"sticker-toggle",STICKER_DRAWER:"sticker-drawer",STICKER_UPLOAD:"sticker-upload",STICKER_GRID:"sticker-grid",CONTEXT_MENU:"custom-context-menu"};
  class BujoStore{
    meta=$state({pageOrder:[],stickers:[],placedImages:[],regions:[],stickerPacks:[],activePackId:"all"});
    pages=$state({});currentP=$state(0);loadedImages=$state({});
    blockMap=new Map();dirtyPages=new Set();isSaving=false;needsSave=false;saveTimeout=null;
    async init(){
      const m={version:4,currentP:0,pageOrder:[],scrolls:[],stickers:[],placedImages:[],regions:[],lines:[],stickerPacks:[],activePackId:"all",...(await FileSystemAPI.readJson("meta.json")||{})};
      if(m.pageOrder.length===0){m.pageOrder.push(`page-${Utils.generateId()}`,`page-${Utils.generateId()}`);await FileSystemAPI.writeJsonAtomic("meta.json",m);}
      this.meta=m;
      if(!this.meta.stickerPacks) this.meta.stickerPacks = [];
      if(!this.meta.activePackId) this.meta.activePackId = "all";
      this.currentP=this.meta.currentP||0;
      await Promise.all(this.meta.regions.map(async r=>{if(!this.pages[r.pageId]){this.pages[r.pageId]=(await FileSystemAPI.readJson(`pages/${r.pageId}.json`))||[this.createBlock()];}}));
      this.rebuildIndex();
    }
    requestSave(f=false){clearTimeout(this.saveTimeout);this.saveTimeout=setTimeout(()=>this.executeSave(f),CONFIG.SAVE_TIMEOUT_MS);}
    async executeSave(f=false){
      if(this.isSaving)return(this.needsSave=true);
      this.isSaving=true;this.needsSave=false;
      try{
        await this.cleanEmptySpreads();this.meta.currentP=this.currentP;
        await FileSystemAPI.writeJsonAtomic("meta.json",$state.snapshot(this.meta));
        const pts=new Set(this.dirtyPages);this.dirtyPages.clear();
        for(const p of pts){if(this.pages[p])await FileSystemAPI.writeJsonAtomic(`pages/${p}.json`,$state.snapshot(this.pages[p]));}
      }catch(e){console.error(e);}finally{this.isSaving=false;if(this.needsSave)this.executeSave();}
    }
    createBlock(text="",depth=0,type="text"){return{id:Utils.generateId(),type,text,depth};}
    rebuildIndex(){this.blockMap.clear();Object.entries(this.pages).forEach(([p,b])=>b.forEach((blk,i)=>this.blockMap.set(blk.id,{pageId:p,bIdx:i,block:blk})));}
    getBlockCoords(id){return this.blockMap.get(id)||null;}
    async cleanEmptySpreads(){
      let c=false;
      for(let i=this.meta.pageOrder.length-1;i>this.currentP;i--){
        const pId=this.meta.pageOrder[i];
        if(!this.meta.placedImages.some(img=>img.pageId===pId)&&!this.meta.regions.some(r=>r.surfaceId===pId)){
          delete this.pages[pId];this.meta.pageOrder.splice(i,1);if(this.meta.scrolls)this.meta.scrolls.splice(i,1);c=true;
        }
      }
      if(this.currentP>=this.meta.pageOrder.length){this.currentP=Math.max(0,this.meta.pageOrder.length-1);c=true;}
      if(c)this.rebuildIndex();return c;
    }
    async ensureEnoughPages(){
      if(this.currentP>=this.meta.pageOrder.length){
        this.meta.pageOrder.push(`page-${Utils.generateId()}`);this.rebuildIndex();
        await FileSystemAPI.writeJsonAtomic("meta.json",$state.snapshot(this.meta));return true;
      }
      return false;
    }
    updateBlock(id,u){const c=this.getBlockCoords(id);if(c){Object.assign(c.block,u);this.dirtyPages.add(c.pageId);this.requestSave();}}
    addBlock(nb,id){const c=this.getBlockCoords(id);if(!c)return;this.pages[c.pageId].splice(c.bIdx+1,0,nb);this.rebuildIndex();this.dirtyPages.add(c.pageId);this.requestSave();}
    removeBlock(id){const c=this.getBlockCoords(id);if(!c)return;this.pages[c.pageId].splice(c.bIdx,1);this.rebuildIndex();this.dirtyPages.add(c.pageId);this.requestSave();}
    moveBlockDOM(id,tId,ia){
      const src=this.getBlockCoords(id),tgt=this.getBlockCoords(tId);if(!src||!tgt)return;
      const [m]=this.pages[src.pageId].splice(src.bIdx,1),sA=src.pageId===tgt.pageId;
      this.pages[tgt.pageId].splice(tgt.bIdx-(sA&&src.bIdx<tgt.bIdx?1:0)+(ia?1:0),0,m);
      this.rebuildIndex();this.dirtyPages.add(src.pageId);if(!sA)this.dirtyPages.add(tgt.pageId);this.requestSave();
    }
    async changePage(d,isR=true){const nP=isR?this.currentP+d:d;if(nP<0)return;this.currentP=nP;await this.ensureEnoughPages();window.scrollTo({top:0,behavior:"smooth"});await this.executeSave();}
    async spawnImage(src,cX,cY){
      const id=Utils.generateId();await FileSystemAPI.writeJsonAtomic(`images/${id}.json`,{src});
      const img={id,pageId:this.meta.pageOrder[this.currentP],left:cX!==undefined?cX-50:100,top:cY!==undefined?cY-50:100,layerBucket:"sticker"};
      this.meta.placedImages.push(img);await this.executeSave();this.renderImage(img);
    }
    async renderImage(d){const f=await FileSystemAPI.readJson(`images/${d.id}.json`);if(f&&f.src)this.loadedImages[d.id]=f.src;}
    updateImage(id,u){const i=this.meta.placedImages.find(i=>i.id===id);if(i){Object.assign(i,u);this.requestSave();}}
    restoreAllImages(){this.meta.placedImages.forEach(d=>this.renderImage(d));}
    async removeImage(id){const idx=this.meta.placedImages.findIndex(i=>i.id===id);if(idx!==-1){this.meta.placedImages.splice(idx,1);await this.executeSave();delete this.loadedImages[id];FileSystemAPI.trashJson(`images/${id}.json`);}}
    async removeRegion(id){
      const idx=this.meta.regions.findIndex(r=>r.id===id);
      if(idx!==-1){
        const r=this.meta.regions[idx];
        this.meta.regions.splice(idx,1);
        const updatedPages={...this.pages};
        delete updatedPages[r.pageId];
        this.pages=updatedPages;
        this.rebuildIndex();
        await this.executeSave();
        await FileSystemAPI.trashJson(`pages/${r.pageId}.json`);
      }
    }
  }
  const store=new BujoStore();
  function pointerAction(node,{onDown,onMove,onUp,ignore}){
    let a=false;
    const d=e=>{if(e.button!==0||(ignore&&ignore(e)))return;a=true;node.setPointerCapture(e.pointerId);if(onDown)onDown(e);},m=e=>{if(a&&onMove)onMove(e);},u=e=>{if(!a)return;a=false;node.releasePointerCapture(e.pointerId);if(onUp)onUp(e);};
    const evs=["pointerdown","pointermove","pointerup","pointercancel"],hs=[d,m,u,u];
    evs.forEach((ev,i)=>node.addEventListener(ev,hs[i]));
    return{destroy(){evs.forEach((ev,i)=>node.removeEventListener(ev,hs[i]));}};
  }
  function draggableImage(node,d){
    let sX,sY,iL,iT;
    return pointerAction(node,{ignore:()=>d.locked,onDown:e=>{sX=e.clientX;sY=e.clientY;iL=d.left;iT=d.top;e.preventDefault();e.stopPropagation();},onMove:e=>{d.left=iL+(e.clientX-sX);d.top=iT+(e.clientY-sY);},onUp:()=>store.requestSave()});
  }
  function draggableRegion(node,rId){
    let sX,sY,iX,iY;
    return pointerAction(node,{ignore:()=>{const r=store.meta.regions.find(r=>r.id===rId);return r&&r.locked;},onDown:e=>{const r=store.meta.regions.find(r=>r.id===rId);if(r){sX=e.clientX;sY=e.clientY;iX=r.x;iY=r.y;e.preventDefault();e.stopPropagation();}},onMove:e=>{const r=store.meta.regions.find(r=>r.id===rId);if(r){r.x=iX+(e.clientX-sX);r.y=iY+(e.clientY-sY);}},onUp:()=>store.requestSave()});
  }
  function resizableRegion(node,rId){
    let sX,sY,iW,iH;
    return pointerAction(node,{ignore:()=>{const r=store.meta.regions.find(r=>r.id===rId);return r&&r.locked;},onDown:e=>{const r=store.meta.regions.find(r=>r.id===rId);if(r){sX=e.clientX;sY=e.clientY;iW=r.width;iH=r.height;e.preventDefault();e.stopPropagation();}},onMove:e=>{const r=store.meta.regions.find(r=>r.id===rId);if(r){r.width=Math.max(CONFIG.MIN_REGION_SIZE,iW+(e.clientX-sX));r.height=Math.max(CONFIG.MIN_REGION_SIZE,iH+(e.clientY-sY));}},onUp:()=>store.requestSave()});
  }
  const Utils={
    generateId:()=>crypto.randomUUID(),clamp:(v,min,max)=>Math.max(min,Math.min(max,v)),
    calcRectOffset:(cX,cY,r)=>({x:cX-r.left,y:cY-r.top}),isInsideRect:(cX,cY,r)=>cX>=r.left&&cX<=r.right&&cY>=r.top&&cY<=r.bottom,isBetweenHorizontally:(cX,r)=>cX>=r.left&&cX<=r.right,
    findWrapperByCoords:(ws,cX)=>ws.find(w=>w&&Utils.isBetweenHorizontally(cX,w.getBoundingClientRect()))||ws[0],
    getBlockClasses:(t)=>`flex-1 outline-none whitespace-pre-wrap min-h-[1.5rem] bullet-text transition-all duration-300 ${CONFIG.H_STYLES[t]||"text-[1.05rem] leading-relaxed"} ${t==="completed"?"line-through text-zinc-400 opacity-60":["migrated","scheduled"].includes(t)?"italic text-zinc-500":""}`.trim(),
    getHandleClasses:(isB)=>`absolute -left-8 top-0.5 w-7 h-7 flex items-center justify-center bullet-handle ${isB?"opacity-100 text-zinc-500":"opacity-0 text-zinc-300"} group-hover:opacity-100 hover:!text-black font-bold transition-all`,
    getNextType:cT=>{const i=CONFIG.CYCLE.indexOf(cT);return i===-1?"task":CONFIG.CYCLE[(i+1)%CONFIG.CYCLE.length];},
    getNextLayer:(cL,d)=>CONFIG.LAYERS[Utils.clamp(CONFIG.LAYERS.indexOf(cL)+d,0,CONFIG.LAYERS.length-1)],
    getNextOpacity:cO=>CONFIG.OPACITIES[(CONFIG.OPACITIES.indexOf(cO??1)+1)%CONFIG.OPACITIES.length],
    gid:id=>document.getElementById(id),qsa:s=>document.querySelectorAll(s)
  };
  const api=window.electronAPI,memFs=new Map();
  const FileSystemAPI={
    readJson:async p=>api?await api.readJson(p):(memFs.get(p)??null),
    writeJsonAtomic:async(p,d)=>api?await api.writeJsonAtomic(p,d):memFs.set(p,d),
    trashJson:async p=>api?await api.trashJson(p):memFs.delete(p)
  };
  const StickerBookManager={
    async saveSticker(b64){
      const id=Utils.generateId();
      await FileSystemAPI.writeJsonAtomic(`images/sticker-${id}.json`,{src:b64});
      if(!store.meta.stickers) store.meta.stickers=[];
      store.meta.stickers = [...store.meta.stickers, id];
      if(activePackId!=="all"&&store.meta.stickerPacks){
        store.meta.stickerPacks = store.meta.stickerPacks.map(p => {
          if (p.id === activePackId) {
            return { ...p, stickers: [...(p.stickers || []), id] };
          }
          return p;
        });
      }
      await store.executeSave();
      this.render();
    },
    async removeSticker(id){
      if (store.meta.stickers) {
        store.meta.stickers = store.meta.stickers.filter(sId => sId !== id);
      }
      if (store.meta.stickerPacks) {
        store.meta.stickerPacks = store.meta.stickerPacks.map(pack => {
          if (pack.stickers) {
            return { ...pack, stickers: pack.stickers.filter(sId => sId !== id) };
          }
          return pack;
        });
      }
      await store.executeSave();
      this.render();
      await FileSystemAPI.trashJson(`images/sticker-${id}.json`);
    },
    async render(){
      const list=activePackId==="all"?(store.meta.stickers||[]):(store.meta.stickerPacks?.find(p=>p.id===activePackId)?.stickers||[]);
      loadedStickers=(await Promise.all(list.map(async id=>{const f=await FileSystemAPI.readJson(`images/sticker-${id}.json`);return f?{id,src:f.src}:null;}))).filter(Boolean);
    }
  };
  const RegionManager={
    startX:0,startY:0,surfaceId:null,
    startDrawing(e){const w=e.target.closest(".page-wrapper");if(!w)return;isDrawingRegion=true;this.surfaceId=w.dataset.pageId;const o=Utils.calcRectOffset(e.clientX,e.clientY,w.getBoundingClientRect());this.startX=o.x;this.startY=o.y;tempRegion={x:this.startX,y:this.startY,w:0,h:0,surfaceId:this.surfaceId};},
    draw(e){if(!isDrawingRegion)return;const w=Array.from(Utils.qsa(".page-wrapper")).find(w=>w.dataset.pageId===this.surfaceId);if(!w)return;const o=Utils.calcRectOffset(e.clientX,e.clientY,w.getBoundingClientRect());tempRegion={...tempRegion,x:Math.min(this.startX,o.x),y:Math.min(this.startY,o.y),w:Math.abs(o.x-this.startX),h:Math.abs(o.y-this.startY)};},
    async stopDrawing(){
      if(!isDrawingRegion)return;isDrawingRegion=false;
      if(tempRegion.w>CONFIG.MIN_REGION_SIZE&&tempRegion.h>CONFIG.MIN_REGION_SIZE){
        const pId=`page-${Utils.generateId()}`,nb=store.createBlock();
        store.meta.regions=[...store.meta.regions,{id:Utils.generateId(),surfaceId:this.surfaceId,x:tempRegion.x,y:tempRegion.y,width:tempRegion.w,height:tempRegion.h,pageId:pId}];
        store.pages={...store.pages,[pId]:[nb]};store.rebuildIndex();store.dirtyPages.add(pId);await store.executeSave();
        activeFocusId=nb.id;activeCursorOffset=0;
      }
    }
  };
  const EditorEngine={
    setBlockType(id,t){store.updateBlock(id,{type:t});},
    indentBlock(id,d){const c=store.getBlockCoords(id);if(c)store.updateBlock(id,{depth:Utils.clamp(c.block.depth+d,0,CONFIG.MAX_DEPTH)});},
    updateText(id,cT){
      const c=store.getBlockCoords(id);if(!c)return;
      let pT=cT.replace(/\u00A0/g," "),nT=c.block.type,isMD=false;
      for(const[p,t]of Object.entries(CONFIG.MD_MAP)){if(pT.startsWith(p)){nT=t;pT=pT.substring(p.length);isMD=true;break;}}
      if(isMD){store.updateBlock(id,{text:pT,type:nT});activeFocusId=id;activeCursorOffset=0;}else store.updateBlock(id,{text:cT});
    },
    cycleType(id){const c=store.getBlockCoords(id);if(c)this.setBlockType(id,Utils.getNextType(c.block.type));},
    splitBlock(id,cP){
      const c=store.getBlockCoords(id);if(!c)return;const{block:b}=c,nT=b.type.startsWith("h")?"text":b.type,nb=store.createBlock(b.text.slice(cP),b.depth,nT);
      store.updateBlock(id,{text:b.text.slice(0,cP)});store.addBlock(nb,id);activeFocusId=nb.id;activeCursorOffset=0;
    },
    mergeWithPrevious(id){
      const c=store.getBlockCoords(id);if(!c||c.bIdx===0)return;
      const p=store.pages[c.pageId][c.bIdx-1],mP=p.text.length;
      store.updateBlock(p.id,{text:p.text+c.block.text});store.removeBlock(id);activeFocusId=p.id;activeCursorOffset=mP;
    },
    navigateVertical(id,d){const c=store.getBlockCoords(id);if(!c)return;const tB=store.pages[c.pageId][c.bIdx+d];if(tB){activeFocusId=tB.id;activeCursorOffset=0;}}
  };
  let scrubTimeout;
  function indicatorScrub(e,ind){
    const r=ind.getBoundingClientRect(),pC=store.meta.pageOrder.length;if(pC<=1)return;
    const idx=Utils.clamp(Math.floor((Utils.clamp(e.clientX-r.left,0,r.width)/r.width)*pC),0,pC-1);
    if(store.currentP!==idx){store.currentP=idx;clearTimeout(scrubTimeout);scrubTimeout=setTimeout(()=>store.changePage(idx,false),50);}
  }
  function autoResize(node,text){
    const r=()=>{node.style.height="auto";node.style.height=node.scrollHeight+"px";};
    node.addEventListener("input",r);setTimeout(r,0);
    return{update(){r();},destroy(){node.removeEventListener("input",r);}};
  }
  const EventController={
    handleDragStart(e){const id=e.target.closest(".bullet-block")?.dataset?.id;if(id)blockDraggingId=id;},
    handleDragOver(e){e.preventDefault();},handleDragEnd(){blockDraggingId=null;},
    handleKeydown(e){
      const id=e.target.dataset.id;
      if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();EditorEngine.splitBlock(id,e.target.selectionStart);}
      if(e.key==="Backspace"&&e.target.selectionStart===0){e.preventDefault();EditorEngine.mergeWithPrevious(id);}
      if(e.key==="Tab"){e.preventDefault();EditorEngine.indentBlock(id,e.shiftKey?-1:1);}
      if(e.key==="ArrowUp"){e.preventDefault();EditorEngine.navigateVertical(id,-1);}
      if(e.key==="ArrowDown"){e.preventDefault();EditorEngine.navigateVertical(id,1);}
    },
    handleGlobalKeydown(e){
      const isInputFocused = ["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName);
      if (isInputFocused) {
        if (e.altKey && e.key === "ArrowLeft") {
          e.preventDefault();
          store.changePage(-1, true);
        } else if (e.altKey && e.key === "ArrowRight") {
          e.preventDefault();
          store.changePage(1, true);
        }
      } else {
        if (e.key === "ArrowLeft" || (e.altKey && e.key === "ArrowLeft")) {
          e.preventDefault();
          store.changePage(-1, true);
        } else if (e.key === "ArrowRight" || (e.altKey && e.key === "ArrowRight")) {
          e.preventDefault();
          store.changePage(1, true);
        }
      }
    },
    handleDblClick(e){}
  };
  function showCustomPrompt(title, defaultValue, callback) {
    promptTitle = title;
    promptValue = defaultValue || "";
    promptCallback = callback;
    promptVisible = true;
    setTimeout(() => {
      const input = document.getElementById("custom-prompt-input");
      if (input) {
        input.focus();
        input.select();
      }
    }, 50);
  }

  function createNewPack() {
    showCustomPrompt("Create New Sticker Pack 📁", "", async (name) => {
      if (!name || !name.trim()) return;
      const newPack = {
        id: `pack-${Utils.generateId()}`,
        name: name.trim(),
        stickers: []
      };
      if (!store.meta) {
        store.meta = { pageOrder: [], stickers: [], placedImages: [], regions: [], stickerPacks: [], activePackId: "all" };
      }
      const currentPacks = store.meta.stickerPacks || [];
      store.meta.stickerPacks = [...currentPacks, newPack];
      store.meta.activePackId = newPack.id;
      activePackId = newPack.id;
      await store.executeSave();
      await StickerBookManager.render();
    });
  }

  function renamePack(packId) {
    if (!store.meta || !store.meta.stickerPacks) return;
    const pack = store.meta.stickerPacks.find(p => p.id === packId);
    if (!pack) return;
    showCustomPrompt("Rename Sticker Pack ✏️", pack.name, async (newName) => {
      if (!newName || !newName.trim()) return;
      store.meta.stickerPacks = store.meta.stickerPacks.map(p => {
        if (p.id === packId) {
          return { ...p, name: newName.trim() };
        }
        return p;
      });
      await store.executeSave();
    });
  }

  async function deletePack(packId) {
    if (!store.meta || !store.meta.stickerPacks) return;
    const pack = store.meta.stickerPacks.find(p => p.id === packId);
    if (!pack) return;
    if (confirm(`Are you sure you want to delete the pack "${pack.name}"? The stickers inside will remain in your general collection.`)) {
      store.meta.stickerPacks = store.meta.stickerPacks.filter(p => p.id !== packId);
      if (activePackId === packId) {
        activePackId = "all";
        store.meta.activePackId = "all";
      }
      await store.executeSave();
      await StickerBookManager.render();
    }
  }

  async function toggleStickerInPack(stickerId, packId) {
    if (!store.meta || !store.meta.stickerPacks) return;
    store.meta.stickerPacks = store.meta.stickerPacks.map(p => {
      if (p.id === packId) {
        const stickers = p.stickers || [];
        if (stickers.includes(stickerId)) {
          return { ...p, stickers: stickers.filter(id => id !== stickerId) };
        } else {
          return { ...p, stickers: [...stickers, stickerId] };
        }
      }
      return p;
    });
    await store.executeSave();
    await StickerBookManager.render();
  }

  async function removeStickerFromPack(stickerId, packId) {
    if (!store.meta || !store.meta.stickerPacks) return;
    store.meta.stickerPacks = store.meta.stickerPacks.map(p => {
      if (p.id === packId) {
        return { ...p, stickers: (p.stickers || []).filter(id => id !== stickerId) };
      }
      return p;
    });
    await store.executeSave();
    await StickerBookManager.render();
  }

  async function addStickerToPack(stickerId, packId) {
    if (!store.meta || !store.meta.stickerPacks) return;
    let added = false;
    store.meta.stickerPacks = store.meta.stickerPacks.map(p => {
      if (p.id === packId) {
        const stickers = p.stickers || [];
        if (!stickers.includes(stickerId)) {
          added = true;
          return { ...p, stickers: [...stickers, stickerId] };
        }
      }
      return p;
    });
    if (added) {
      await store.executeSave();
      await StickerBookManager.render();
    }
  }



  $effect(() => {
    if (activePackId) {
      StickerBookManager.render();
    }
  });

  onMount(()=>{
    let d=false;
    const init=async()=>{
      await store.init();
      if(d)return;
      activePackId=store.meta.activePackId||"all";
      StickerBookManager.render();
      store.restoreAllImages();
    };
    init();
    window.addEventListener("beforeunload",()=>{if(store.saveTimeout){clearTimeout(store.saveTimeout);store.executeSave();}});
    return()=>{d=true;};
  });
  function autoFocus(node,{id,focusId,offset}){
    $effect(()=>{if(id===focusId){node.focus();const tP=Math.min(offset,node.value.length);node.setSelectionRange(tP,tP);activeFocusId=null;}});
  }
</script>

<svelte:window onclick={()=>contextMenuVisible=false} onkeydown={EventController.handleGlobalKeydown}/>
<button id="sticker-toggle" class="fixed top-6 right-6 w-12 h-12 bg-zinc-900 text-white rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.15)] text-2xl z-[60] hover:scale-110 active:scale-95 hover:bg-zinc-800 transition-all duration-300 flex items-center justify-center border border-zinc-800" onclick={()=>stickerDrawerOpen=!stickerDrawerOpen}>🎒</button>
<div id="sticker-drawer" class="fixed top-0 right-0 w-[340px] h-screen bg-white/90 backdrop-blur-lg shadow-[-10px_0_40px_rgba(0,0,0,0.04)] z-[50] transform transition-transform duration-500 ease-out border-l border-zinc-200/60 p-6 overflow-y-auto {stickerDrawerOpen?'translate-x-0':'translate-x-full'}">
  <div class="flex items-center justify-between mb-2 mt-16">
    <h2 class="text-2xl font-extrabold text-zinc-800 tracking-tight">Stickers 🌟</h2>
    <span class="text-xs font-semibold px-2 py-0.5 bg-zinc-100 text-zinc-600 rounded-full border border-zinc-200/60 shadow-sm">
      {loadedStickers.length} {loadedStickers.length === 1 ? 'sticker' : 'stickers'}
    </span>
  </div>
  <p class="text-xs text-zinc-500 mb-5 leading-relaxed">Double-click any floating image on your page to save it here! Or upload new ones directly 👇 💡 <b>Drag stickers onto tabs</b> to organize them, or right-click for options.</p>
  
  <!-- Sticker Packs Tabs -->
  <div class="flex flex-wrap gap-1.5 items-center mb-6 pb-2 border-b border-zinc-100">
    <button 
      class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 active:scale-95 border {activePackId === 'all' ? 'bg-zinc-900 text-white border-zinc-900 shadow-sm' : 'bg-zinc-50 hover:bg-zinc-100 text-zinc-600 border-zinc-200/50'}"
      onclick={() => { activePackId = 'all'; store.meta.activePackId = 'all'; store.requestSave(); }}
      ondragover={e => {
        if (activePackId !== "all") {
          e.preventDefault();
          e.currentTarget.classList.add("!bg-zinc-800", "!text-white", "scale-105", "!border-zinc-800");
        }
      }}
      ondragleave={e => {
        e.currentTarget.classList.remove("!bg-zinc-800", "!text-white", "scale-105", "!border-zinc-800");
      }}
      ondrop={async e => {
        e.preventDefault();
        e.currentTarget.classList.remove("!bg-zinc-800", "!text-white", "scale-105", "!border-zinc-800");
        if (activePackId === "all") return;
        try {
          const data = JSON.parse(e.dataTransfer.getData("application/json"));
          if (data && data.type === "sticker" && data.id) {
            await removeStickerFromPack(data.id, activePackId);
          }
        } catch (err) {
          console.error(err);
        }
      }}
      title={activePackId !== "all" ? "Drag stickers here to remove them from the active pack" : "All Stickers"}
    >
      All
    </button>
    
    {#if store.meta.stickerPacks}
      {#each store.meta.stickerPacks as pack (pack.id)}
        <button 
          class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 active:scale-95 border {activePackId === pack.id ? 'bg-zinc-900 text-white border-zinc-900 shadow-sm' : 'bg-zinc-50 hover:bg-zinc-100 text-zinc-600 border-zinc-200/50'}"
          onclick={() => { activePackId = pack.id; store.meta.activePackId = pack.id; store.requestSave(); }}
          oncontextmenu={e => {
            e.preventDefault();
            e.stopPropagation();
            contextMenuX = e.clientX;
            contextMenuY = e.clientY;
            contextMenuItems = [
              {
                label: "Rename Pack ✏️",
                action: () => renamePack(pack.id)
              },
              {
                label: "Delete Pack 🗑️",
                danger: true,
                action: () => deletePack(pack.id)
              }
            ];
            contextMenuVisible = true;
          }}
          ondragover={e => {
            e.preventDefault();
            e.currentTarget.classList.add("!bg-zinc-800", "!text-white", "scale-105", "!border-zinc-800");
          }}
          ondragleave={e => {
            e.currentTarget.classList.remove("!bg-zinc-800", "!text-white", "scale-105", "!border-zinc-800");
          }}
          ondrop={async e => {
            e.preventDefault();
            e.currentTarget.classList.remove("!bg-zinc-800", "!text-white", "scale-105", "!border-zinc-800");
            try {
              const data = JSON.parse(e.dataTransfer.getData("application/json"));
              if (data && data.type === "sticker" && data.id) {
                await addStickerToPack(data.id, pack.id);
              }
            } catch (err) {
              console.error(err);
            }
          }}
          title="Right-click to rename/delete. Drag stickers here to add."
        >
          {pack.name}
        </button>
      {/each}
    {/if}
    
    <button 
      class="w-7 h-7 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 flex items-center justify-center text-sm font-bold border border-zinc-200/60 active:scale-95 transition-all duration-200"
      onclick={() => createNewPack()}
      title="Create New Sticker Pack"
    >
      ＋
    </button>
  </div>

  <label class="block w-full cursor-pointer bg-zinc-900 text-white hover:bg-zinc-800 text-center py-3 rounded-xl font-medium text-sm mb-6 transition-all duration-300 hover:shadow-md active:scale-[0.98] border border-transparent">➕ Upload Sticker<input type="file" id="sticker-upload" accept="image/*" class="hidden" onchange={e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>StickerBookManager.saveSticker(ev.target.result);r.readAsDataURL(f);}}/></label>
  <div id="sticker-grid" class="grid grid-cols-2 gap-4">
    {#if loadedStickers.length===0}<div class="col-span-2 text-center text-sm text-zinc-400 mt-4">No stickers saved yet! 😿</div>
    {:else}{#each loadedStickers as s (s.id)}
      <div 
        class="sticker-item relative cursor-pointer group flex items-center justify-center p-3 bg-white/60 hover:bg-white rounded-2xl shadow-sm border border-zinc-200/50 hover:border-zinc-300 hover:shadow-[0_8px_20px_rgba(0,0,0,0.06)] hover:-translate-y-0.5 active:scale-95 transition-all duration-300" 
        data-sticker-id={s.id} 
        draggable="true" 
        ondragstart={e=>e.dataTransfer.setData("application/json",JSON.stringify({type:"sticker",src:s.src}))} 
        onclick={()=>store.spawnImage(s.src)}
        oncontextmenu={e => {
          e.preventDefault();
          e.stopPropagation();
          contextMenuX = e.clientX;
          contextMenuY = e.clientY;
          
          const items = [];
          
          items.push({
            label: "Manage Packs... 📂",
            action: () => {
              packSelectorStickerId = s.id;
              packSelectorVisible = true;
            }
          });

          if (activePackId !== "all") {
            const activePack = store.meta.stickerPacks?.find(p => p.id === activePackId);
            items.push({
              label: `Remove from "${activePack?.name || 'Pack'}" ❌`,
              action: () => {
                removeStickerFromPack(s.id, activePackId);
              }
            });
          }

          items.push({
            label: "Delete Globally 🗑️",
            danger: true,
            action: () => {
              if (confirm("Are you sure you want to delete this sticker permanently from all collections?")) {
                StickerBookManager.removeSticker(s.id);
              }
            }
          });
          
          contextMenuItems = items;
          contextMenuVisible = true;
        }}
      >
        <img src={s.src} draggable="false" class="max-w-full max-h-24 object-contain filter drop-shadow-sm group-hover:drop-shadow-md" alt="sticker"/>
        <button 
          class="absolute top-1.5 right-1.5 w-5 h-5 bg-red-50 hover:bg-red-100 border border-red-200 text-red-500 rounded-full flex items-center justify-center text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-opacity duration-200" 
          onclick={e => {
            e.stopPropagation(); 
            if (activePackId === "all") {
              if (confirm("Delete this sticker permanently from all collections?")) {
                StickerBookManager.removeSticker(s.id);
              }
            } else {
              removeStickerFromPack(s.id, activePackId);
            }
          }} 
          title={activePackId === "all" ? "Delete sticker globally" : "Remove sticker from this pack"}
        >
          ✕
        </button>
      </div>
    {/each}{/if}
  </div>
</div>

<div id="app" class="flex w-full min-h-screen will-change-transform relative items-start {isScrubbing?'!transition-none':'transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]'}" style="transform: translateX(-{store.currentP*100}vw)">
  {#each store.meta.pageOrder as pId,i (pId)}
    <div class="page-wrapper w-[100vw] min-h-screen flex-shrink-0 relative flex justify-center overflow-hidden" data-page-id={pId} use:pointerAction={{ignore:e=>["TEXTAREA","BUTTON"].includes(e.target.tagName)||e.target.classList.contains("bullet-text")||e.target.closest(".region-box")||e.target.closest(".draggable-image")||e.target.closest("#sticker-drawer")||e.target.closest("#page-indicator"),onDown:e=>RegionManager.startDrawing(e),onMove:e=>RegionManager.draw(e),onUp:e=>RegionManager.stopDrawing(e)}} ondblclick={e=>EventController.handleDblClick(e)} ondragover={e=>e.preventDefault()} ondrop={async e=>{
      e.preventDefault();
      const dStr=e.dataTransfer.getData("application/json");
      if(dStr){
        try{
          const d=JSON.parse(dStr);
          if(d.type==="sticker"){
            const rect=e.currentTarget.getBoundingClientRect();
            store.spawnImage(d.src,e.clientX-rect.left,e.clientY-rect.top);
          }
        }catch(err){console.error(err);}
      }
    }}>
      <div class="absolute bottom-8 left-0 w-full text-center text-zinc-400 text-sm font-mono tracking-widest select-none pointer-events-none">{i+1}</div>
      {#each store.meta.regions.filter(r=>r.surfaceId===pId) as r (r.id)}
        <div class="region-box absolute bg-zinc-50/80 hover:bg-zinc-100/80 border transition-colors duration-300 rounded-lg flex flex-col layer-paper {focusedRegionId === r.id ? 'bg-white border-zinc-800 shadow-md ring-1 ring-zinc-800/10' : 'border-zinc-300 hover:border-zinc-400 shadow-sm'}" data-region-id={r.id} data-page-id={r.pageId} data-locked={r.locked?"true":null} style="left:{r.x}px;top:{r.y}px;width:{r.width}px;height:{r.height}px" oncontextmenu={e=>{
          e.preventDefault();
          e.stopPropagation();
          contextMenuX = e.clientX;
          contextMenuY = e.clientY;
          contextMenuItems = [
            {
              label: r.locked ? "Unlock Position 🔓" : "Lock Position 🔒",
              action: () => {
                r.locked = !r.locked;
                store.requestSave();
              }
            },
            {
              label: "Clear Content 🧹",
              action: () => {
                if (confirm("Are you sure you want to clear all bullet points in this region?")) {
                  store.pages[r.pageId] = [store.createBlock()];
                  store.rebuildIndex();
                  store.dirtyPages.add(r.pageId);
                  store.requestSave();
                }
              }
            },
            {
              label: "Delete Region 🗑️",
              danger: true,
              action: () => {
                if (confirm("Are you sure you want to delete this region and all its content?")) {
                  store.removeRegion(r.id);
                }
              }
            }
          ];
          contextMenuVisible = true;
        }}>
          <div use:draggableRegion={r.id} class="region-header h-5 bg-transparent {r.locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'} rounded-t-lg flex items-center px-2 hover:bg-black/5 transition-colors group"></div>
          <div class="region-content flex-1 overflow-y-auto py-4 pr-4 pl-10 cursor-text" style="touch-action: pan-y;">
            <div class="bujo-list min-h-full" data-region-page-id={r.pageId} ondragover={e=>EventController.handleDragOver(e)} ondragend={e=>EventController.handleDragEnd(e)} ondrop={e=>{e.preventDefault();const dId=e.dataTransfer.getData("text/plain"),tB=e.target.closest(".bullet-block");if(dId&&tB){const rect=tB.getBoundingClientRect();store.moveBlockDOM(dId,tB.dataset.id,e.clientY>rect.top+rect.height/2);}blockDraggingId=null;}}>
              {#if store.pages[r.pageId]}{#each store.pages[r.pageId] as b (b.id)}
                <div class="relative flex items-start mb-2 bullet-block group {blockDraggingId===b.id?'dragging':''}" data-id={b.id} style="margin-left:{b.depth*CONFIG.INDENT_PX}px" draggable={blockDraggingId===b.id?"true":"false"} ondragstart={e=>EventController.handleDragStart(e)}>
                  <div class={Utils.getHandleClasses(CONFIG.CYCLE.includes(b.type))} draggable="true" ondragstart={e=>{e.dataTransfer.setData("text/plain",b.id);blockDraggingId=b.id;}} ondragend={()=>blockDraggingId=null}>{CONFIG.CYCLE.includes(b.type)?CONFIG.BULLETS[b.type]:"::"}</div>
                  <textarea data-id={b.id} use:autoFocus={{id:b.id,focusId:activeFocusId,offset:activeCursorOffset}} class="{Utils.getBlockClasses(b.type)} resize-none overflow-hidden bg-transparent" rows="1" spellcheck="false" bind:value={b.text} use:autoResize={b.text} onkeydown={e=>EventController.handleKeydown(e)} oninput={e=>EditorEngine.updateText(b.id,e.target.value)} onfocus={() => focusedRegionId = r.id} onblur={() => { if (focusedRegionId === r.id) focusedRegionId = null; }}></textarea>
                </div>
              {/each}{/if}
            </div>
          </div>
          {#if !r.locked}
            <div use:resizableRegion={r.id} class="region-resizer absolute bottom-0 right-0 w-5 h-5 cursor-se-resize flex items-end justify-end p-1 opacity-0 hover:opacity-100 transition-opacity"><div class="w-2 h-2 border-r-2 border-b-2 border-zinc-400 rounded-sm pointer-events-none"></div></div>
          {/if}
        </div>
      {/each}
      {#if isDrawingRegion&&tempRegion.surfaceId===pId}<div class="absolute border border-zinc-400 bg-white/20 rounded-lg pointer-events-none layer-focus" style="left:{tempRegion.x}px;top:{tempRegion.y}px;width:{tempRegion.w}px;height:{tempRegion.h}px"></div>{/if}
      {#each store.meta.placedImages.filter(img=>img.pageId===pId) as img (img.id)}
        {#if store.loadedImages[img.id]}
          <img src={store.loadedImages[img.id]} oncontextmenu={e=>{
            e.preventDefault();
            e.stopPropagation();
            contextMenuX=e.clientX;
            contextMenuY=e.clientY;
            contextMenuItems=[
              {label:img.locked ? "Unlock Position 🔓" : "Lock Position 🔒", action:()=>{img.locked=!img.locked;store.requestSave();}},
              {label:`Opacity: ${Math.round((img.opacity??1)*100)}% 💧`, action:()=>{img.opacity=Utils.getNextOpacity(img.opacity);store.requestSave();}},
              {label:"Rotate (45°) 🔄", action:()=>{img.rotation=((img.rotation||0)+45)%360;store.requestSave();}},
              {label:`Layer: ${img.layerBucket||'sticker'} 📑`, action:()=>{img.layerBucket=Utils.getNextLayer(img.layerBucket||'sticker',1);store.requestSave();}},
              {label:"Delete Image 🗑️", danger:true, action:()=>store.removeImage(img.id)}
            ];
            contextMenuVisible=true;
          }} ondblclick={async e=>{
            e.stopPropagation();
            const src=store.loadedImages[img.id];
            if(src){
              await StickerBookManager.saveSticker(src);
              const toggle=document.getElementById("sticker-toggle");
              if(toggle){
                toggle.classList.add("animate-bounce");
                setTimeout(()=>toggle.classList.remove("animate-bounce"),1000);
              }
            }
          }} class="draggable-image layer-{img.layerBucket||'sticker'} transition-transform duration-200 {zoomedImgId===img.id?'scale-125':'scale-100'}" data-img-id={img.id} data-page-id={img.pageId} data-locked={img.locked?"true":null} alt="placed" style="left:{img.left}px;top:{img.top}px;rotate:{img.rotation||0}deg;opacity:{img.opacity??1};" use:draggableImage={img}/>
        {/if}
      {/each}
    </div>
  {/each}
</div>

<div id="page-indicator" class="fixed bottom-6 left-1/2 -translate-x-1/2 flex gap-3 z-50 px-6 py-3.5 bg-zinc-100/90 backdrop-blur-md border border-zinc-300 rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.12)] cursor-grab active:cursor-grabbing touch-none items-center" onpointerdown={e=>{const i=e.currentTarget;i.setPointerCapture(e.pointerId);i._isScrubbing=true;isScrubbing=true;indicatorScrub(e,i);}} onpointermove={e=>{const i=e.currentTarget;if(i._isScrubbing)indicatorScrub(e,i);}} onpointerup={async e=>{const i=e.currentTarget;i._isScrubbing=false;isScrubbing=false;i.releasePointerCapture(e.pointerId);await store.executeSave();}} onclick={e=>{const d=e.target.closest(".indicator-dot");if(d)store.changePage(parseInt(d.dataset.idx),false);}}>
  {#each store.meta.pageOrder as _,i}
    <span data-idx={i} class="indicator-dot pointer-events-none h-2.5 rounded-full transition-all duration-300 {i===store.currentP?'w-7 bg-zinc-800':'w-2.5 bg-zinc-300 hover:bg-zinc-400'}"></span>
  {/each}
</div>

{#if contextMenuVisible}
  <div id="custom-context-menu" class="fixed bg-white border border-zinc-200 shadow-xl rounded-md py-1 z-[100] w-48" style="left:{contextMenuX}px;top:{contextMenuY}px">
    {#each contextMenuItems as item}
      <button class="w-full text-left px-3 py-1.5 hover:bg-zinc-100 text-sm {item.danger?'text-red-600':'text-zinc-800'}" onclick={e=>{e.stopPropagation();item.action();contextMenuVisible=false;}}>{item.label}</button>
    {/each}
  </div>
{/if}

{#if promptVisible}
  <div class="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center transition-all duration-300">
    <div class="bg-white rounded-2xl shadow-2xl border border-zinc-200 p-6 w-[360px] animate-[slideIn_0.2s_ease-out_forwards]">
      <h3 class="text-lg font-bold text-zinc-800 mb-3">{promptTitle}</h3>
      <input 
        id="custom-prompt-input" 
        type="text" 
        bind:value={promptValue} 
        class="w-full bg-zinc-50 border border-zinc-200 text-zinc-800 rounded-xl px-3 py-2.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-zinc-800/10 focus:border-zinc-800 transition-all duration-300 mb-4"
        placeholder="Enter pack name..."
        onkeydown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (promptCallback) promptCallback(promptValue);
            promptVisible = false;
          } else if (e.key === "Escape") {
            e.preventDefault();
            promptVisible = false;
          }
        }}
      />
      <div class="flex gap-2 justify-end">
        <button 
          class="px-4 py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 rounded-xl text-xs font-semibold active:scale-95 transition-all duration-200" 
          onclick={() => promptVisible = false}
        >
          Cancel
        </button>
        <button 
          class="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl text-xs font-semibold active:scale-95 transition-all duration-200" 
          onclick={() => {
            if (promptCallback) promptCallback(promptValue);
            promptVisible = false;
          }}
        >
          Save
        </button>
      </div>
    </div>
  </div>
{/if}

{#if packSelectorVisible}
  <div class="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center transition-all duration-300">
    <div class="bg-white rounded-2xl shadow-2xl border border-zinc-200 p-6 w-[360px] animate-[slideIn_0.2s_ease-out_forwards]">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold text-zinc-800">Manage Sticker Packs 📂</h3>
        <button 
          class="w-6 h-6 flex items-center justify-center rounded-full hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-colors"
          onclick={() => packSelectorVisible = false}
        >
          ✕
        </button>
      </div>
      
      <p class="text-xs text-zinc-500 mb-4">Select which custom packs should include this sticker:</p>
      
      <div class="space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
        {#if !store.meta.stickerPacks || store.meta.stickerPacks.length === 0}
          <div class="text-center py-6 text-sm text-zinc-400 border border-dashed border-zinc-200 rounded-xl">
            No custom packs created yet! 📁
          </div>
        {:else}
          {#each store.meta.stickerPacks as pack (pack.id)}
            {@const isMember = pack.stickers && pack.stickers.includes(packSelectorStickerId)}
            <button 
              class="w-full flex items-center justify-between p-3 rounded-xl border text-sm font-semibold transition-all duration-200 active:scale-[0.98] {isMember ? 'bg-zinc-900 text-white border-zinc-900 shadow-sm' : 'bg-zinc-50 hover:bg-zinc-100 text-zinc-700 border-zinc-200/50'}"
              onclick={() => toggleStickerInPack(packSelectorStickerId, pack.id)}
            >
              <span>{pack.name}</span>
              {#if isMember}
                <span class="text-xs font-bold bg-white/20 px-2 py-0.5 rounded-full">✓ Added</span>
              {:else}
                <span class="text-xs text-zinc-400">＋ Add</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
      
      <div class="mt-6 flex justify-end">
        <button 
          class="px-5 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl text-xs font-semibold active:scale-95 transition-all duration-200 shadow-sm" 
          onclick={() => packSelectorVisible = false}
        >
          Done
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
:global(body){overflow-x:hidden;overflow-y:auto;background-color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}:global([contenteditable]:empty::before){content:"\FEFF"}.bullet-block{animation:slideIn 0.15s ease-out forwards;cursor:default}@keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}:global(::-webkit-scrollbar){display:none}.bullet-handle{cursor:grab;user-select:none}.bullet-handle:active{cursor:grabbing}.dragging{opacity:0.3}.bullet-text{cursor:text;user-select:text;word-break:break-word;-webkit-hyphens:auto;hyphens:auto}.region-content::-webkit-scrollbar{display:none}.draggable-image{position:absolute;top:0;left:0;cursor:grab;max-width:300px;filter:drop-shadow(0px 8px 12px rgba(0,0,0,0.15));user-select:none;transition:scale 0.2s ease,rotate 0.2s ease,opacity 0.2s ease}.draggable-image:active{cursor:grabbing}.draggable-image[data-locked="true"]{cursor:default}.draggable-image[data-locked="true"]:active{cursor:default}:global(.layer-background){z-index:10}:global(.layer-paper){z-index:20}:global(.layer-sticker){z-index:30}:global(.layer-floating){z-index:40}:global(.layer-focus){z-index:50}
</style>