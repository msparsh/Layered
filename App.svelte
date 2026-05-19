<script>
  import { onMount, tick } from "svelte";
  let isScrubbing=$state(false),zoomedImgId=$state(null),stickerDrawerOpen=$state(false),loadedStickers=$state([]),contextMenuVisible=$state(false),contextMenuX=$state(0),contextMenuY=$state(0),contextMenuItems=$state([]),isDrawingRegion=$state(false),tempRegion=$state({x:0,y:0,w:0,h:0}),regionDragId=$state(null),blockDraggingId=$state(null),activeFocusId=$state(null),activeCursorOffset=$state(0);
  const CONFIG={BULLETS:{task:"•",completed:"✕",migrated:">",scheduled:"<",event:"○",note:"-"},CYCLE:["task","completed","migrated","scheduled","event","note"],MD_MAP:{"* ":"task","x ":"completed","> ":"migrated","< ":"scheduled","o ":"event","- ":"note","# ":"h1","## ":"h2","### ":"h3","#### ":"h4","##### ":"h5","###### ":"h6"},H_STYLES:{h1:"text-4xl font-bold mt-6 mb-2",h2:"text-3xl font-bold mt-5 mb-2",h3:"text-2xl font-bold mt-4 mb-1",h4:"text-xl font-semibold mt-3 mb-1",h5:"text-lg font-semibold mt-2 mb-1",h6:"text-base font-semibold uppercase tracking-wider mt-2 mb-1 text-zinc-500"},SAVE_TIMEOUT_MS:500,LAYERS:["background","paper","sticker","floating","focus"],OPACITIES:[1,0.75,0.5,0.25],INDENT_PX:28,MIN_REGION_SIZE:50,KEY_JUMP_THRESHOLD:24,MAX_DEPTH:4};
  const DOM_IDS={APP:"app",INDICATOR:"page-indicator",STICKER_TOGGLE:"sticker-toggle",STICKER_DRAWER:"sticker-drawer",STICKER_UPLOAD:"sticker-upload",STICKER_GRID:"sticker-grid",CONTEXT_MENU:"custom-context-menu"};
  class BujoStore{
    meta=$state({pageOrder:[],stickers:[],placedImages:[],regions:[]});
    pages=$state({});currentP=$state(0);loadedImages=$state({});
    blockMap=new Map();dirtyPages=new Set();isSaving=false;needsSave=false;saveTimeout=null;
    async init(){
      const m={version:4,currentP:0,pageOrder:[],scrolls:[],stickers:[],placedImages:[],regions:[],lines:[],...(await FileSystemAPI.readJson("meta.json")||{})};
      if(m.pageOrder.length===0){m.pageOrder.push(`page-${Utils.generateId()}`,`page-${Utils.generateId()}`);await FileSystemAPI.writeJsonAtomic("meta.json",m);}
      this.meta=m;this.currentP=this.meta.currentP||0;
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
      while(this.meta.pageOrder.length>1&&this.meta.pageOrder.length-1!==this.currentP){
        const i=this.meta.pageOrder.length-1,pId=this.meta.pageOrder[i];
        if(!this.meta.placedImages.some(img=>img.pageId===pId)&&!this.meta.regions.some(r=>r.surfaceId===pId)){
          delete this.pages[pId];this.meta.pageOrder.splice(i,1);if(this.meta.scrolls)this.meta.scrolls.splice(i,1);c=true;
        }else break;
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
    return pointerAction(node,{onDown:e=>{const r=store.meta.regions.find(r=>r.id===rId);if(r){sX=e.clientX;sY=e.clientY;iX=r.x;iY=r.y;e.preventDefault();e.stopPropagation();}},onMove:e=>{const r=store.meta.regions.find(r=>r.id===rId);if(r){r.x=iX+(e.clientX-sX);r.y=iY+(e.clientY-sY);}},onUp:()=>store.requestSave()});
  }
  function resizableRegion(node,rId){
    let sX,sY,iW,iH;
    return pointerAction(node,{onDown:e=>{const r=store.meta.regions.find(r=>r.id===rId);if(r){sX=e.clientX;sY=e.clientY;iW=r.width;iH=r.height;e.preventDefault();e.stopPropagation();}},onMove:e=>{const r=store.meta.regions.find(r=>r.id===rId);if(r){r.width=Math.max(CONFIG.MIN_REGION_SIZE,iW+(e.clientX-sX));r.height=Math.max(CONFIG.MIN_REGION_SIZE,iH+(e.clientY-sY));}},onUp:()=>store.requestSave()});
  }
  const Utils={
    generateId:()=>crypto.randomUUID(),clamp:(v,min,max)=>Math.max(min,Math.min(max,v)),
    calcRectOffset:(cX,cY,r)=>({x:cX-r.left,y:cY-r.top}),isInsideRect:(cX,cY,r)=>cX>=r.left&&cX<=r.right&&cY>=r.top&&cY<=r.bottom,isBetweenHorizontally:(cX,r)=>cX>=r.left&&cX<=r.right,
    findWrapperByCoords:(ws,cX)=>ws.find(w=>w&&this.isBetweenHorizontally(cX,w.getBoundingClientRect()))||ws[0],
    getBlockClasses:(t)=>`flex-1 outline-none whitespace-pre-wrap min-h-[1.5rem] bullet-text transition-all duration-300 ${CONFIG.H_STYLES[t]||"text-[1.05rem] leading-relaxed"} ${t==="completed"?"line-through text-zinc-400 opacity-60":["migrated","scheduled"].includes(t)?"italic text-zinc-500":""}`.trim(),
    getHandleClasses:(isB)=>`absolute -left-8 top-0.5 w-7 h-7 flex items-center justify-center bullet-handle ${isB?"opacity-40 text-zinc-500":"opacity-0 text-zinc-300"} group-hover:opacity-100 hover:!text-black font-bold transition-all`,
    getNextType:cT=>{const i=CONFIG.CYCLE.indexOf(cT);return i===-1?"task":CONFIG.CYCLE[(i+1)%CONFIG.CYCLE.length];},
    getNextLayer:(cL,d)=>CONFIG.LAYERS[this.clamp(CONFIG.LAYERS.indexOf(cL)+d,0,CONFIG.LAYERS.length-1)],
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
    async saveSticker(b64){const id=Utils.generateId();await FileSystemAPI.writeJsonAtomic(`images/sticker-${id}.json`,{src:b64});store.meta.stickers.push(id);await store.executeSave();this.render();},
    async removeSticker(id){const i=store.meta.stickers.indexOf(id);if(i!==-1){store.meta.stickers.splice(i,1);await store.executeSave();this.render();await FileSystemAPI.trashJson(`images/sticker-${id}.json`);}},
    async render(){loadedStickers=(await Promise.all(store.meta.stickers.map(async id=>{const f=await FileSystemAPI.readJson(`images/sticker-${id}.json`);return f?{id,src:f.src}:null;}))).filter(Boolean);}
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
    handleContextMenu(e){e.preventDefault();contextMenuX=e.clientX;contextMenuY=e.clientY;contextMenuItems=[{label:"Page Options 📄",action:()=>console.log("Wrapper clicked!")}];contextMenuVisible=true;},
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
    handleDblClick(e){}
  };
  onMount(()=>{
    let d=false;
    const init=async()=>{await store.init();if(d)return;StickerBookManager.render();store.restoreAllImages();};
    init();
    window.addEventListener("beforeunload",()=>{if(store.saveTimeout){clearTimeout(store.saveTimeout);store.executeSave();}});
    return()=>{d=true;};
  });
  function autoFocus(node,{id,focusId,offset}){
    $effect(()=>{if(id===focusId){node.focus();const tP=Math.min(offset,node.value.length);node.setSelectionRange(tP,tP);activeFocusId=null;}});
  }
</script>

<svelte:window onclick={()=>contextMenuVisible=false}/>
<button id="sticker-toggle" class="fixed top-6 right-6 w-12 h-12 bg-white rounded-full shadow-lg text-2xl z-[60] hover:scale-110 transition-transform flex items-center justify-center border border-zinc-100" onclick={()=>stickerDrawerOpen=!stickerDrawerOpen}>🎒</button>
<div id="sticker-drawer" class="fixed top-0 right-0 w-80 h-screen bg-zinc-50 shadow-2xl z-[50] transform transition-transform duration-300 ease-out border-l border-zinc-200 p-6 overflow-y-auto {stickerDrawerOpen?'translate-x-0':'translate-x-full'}">
  <h2 class="text-2xl font-bold mb-2 mt-16 text-zinc-800">Stickers 🌟</h2>
  <p class="text-xs text-zinc-500 mb-6 leading-relaxed">Double-click any floating image on your page to save it here! Or upload new ones directly 👇</p>
  <label class="block w-full cursor-pointer bg-zinc-800 text-white hover:bg-zinc-700 text-center py-3 rounded-lg font-semibold text-sm mb-6 transition-colors shadow-md">➕ Upload Sticker<input type="file" id="sticker-upload" accept="image/*" class="hidden" onchange={e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>StickerBookManager.saveSticker(ev.target.result);r.readAsDataURL(f);}}/></label>
  <div id="sticker-grid" class="grid grid-cols-2 gap-4">
    {#if loadedStickers.length===0}<div class="col-span-2 text-center text-sm text-zinc-400 mt-4">No stickers saved yet! 😿</div>
    {:else}{#each loadedStickers as s (s.id)}
      <div class="sticker-item cursor-pointer group flex items-center justify-center p-2 bg-white rounded-lg shadow-sm border border-zinc-100 hover:shadow-md hover:-translate-y-1 transition-all" data-sticker-id={s.id} draggable="true" ondragstart={e=>e.dataTransfer.setData("application/json",JSON.stringify({type:"sticker",src:s.src}))} onclick={()=>store.spawnImage(s.src)} oncontextmenu={e=>EventController.handleContextMenu(e)}>
        <img src={s.src} draggable="false" class="max-w-full max-h-24 object-contain filter drop-shadow-sm group-hover:drop-shadow-md" alt="sticker"/>
      </div>
    {/each}{/if}
  </div>
</div>

<div id="app" class="flex w-full min-h-screen will-change-transform relative items-start {isScrubbing?'!transition-none':'transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]'}" style="transform: translateX(-{store.currentP*100}vw)">
  {#each store.meta.pageOrder as pId,i (pId)}
    <div class="page-wrapper w-[100vw] min-h-screen flex-shrink-0 relative flex justify-center overflow-hidden" data-page-id={pId} use:pointerAction={{ignore:e=>["TEXTAREA","BUTTON"].includes(e.target.tagName)||e.target.classList.contains("bullet-text")||e.target.closest(".region-box")||e.target.closest(".draggable-image")||e.target.closest("#sticker-drawer")||e.target.closest("#page-indicator"),onDown:e=>RegionManager.startDrawing(e),onMove:e=>RegionManager.draw(e),onUp:e=>RegionManager.stopDrawing(e)}} ondblclick={e=>EventController.handleDblClick(e)} oncontextmenu={e=>EventController.handleContextMenu(e)}>
      <div class="absolute bottom-8 left-0 w-full text-center text-zinc-400 text-sm font-mono tracking-widest select-none pointer-events-none">{i+1}</div>
      {#each store.meta.regions.filter(r=>r.surfaceId===pId) as r (r.id)}
        <div class="region-box absolute bg-transparent hover:bg-white/40 border border-transparent hover:border-zinc-200 transition-colors duration-300 rounded-lg flex flex-col layer-paper" data-region-id={r.id} data-page-id={r.pageId} style="left:{r.x}px;top:{r.y}px;width:{r.width}px;height:{r.height}px">
          <div use:draggableRegion={r.id} class="region-header h-5 bg-transparent cursor-grab active:cursor-grabbing rounded-t-lg flex items-center px-2 hover:bg-black/5 transition-colors group"></div>
          <div class="region-content flex-1 overflow-y-auto py-4 pr-4 pl-10 cursor-text" style="touch-action: pan-y;">
            <div class="bujo-list min-h-full" data-region-page-id={r.pageId} ondragover={e=>EventController.handleDragOver(e)} ondragend={e=>EventController.handleDragEnd(e)} ondrop={e=>{e.preventDefault();const dId=e.dataTransfer.getData("text/plain"),tB=e.target.closest(".bullet-block");if(dId&&tB){const rect=tB.getBoundingClientRect();store.moveBlockDOM(dId,tB.dataset.id,e.clientY>rect.top+rect.height/2);}blockDraggingId=null;}}>
              {#if store.pages[r.pageId]}{#each store.pages[r.pageId] as b (b.id)}
                <div class="relative flex items-start mb-2 bullet-block group {blockDraggingId===b.id?'dragging':''}" data-id={b.id} style="margin-left:{b.depth*CONFIG.INDENT_PX}px" draggable={blockDraggingId===b.id?"true":"false"} ondragstart={e=>EventController.handleDragStart(e)}>
                  <div class={Utils.getHandleClasses(CONFIG.CYCLE.includes(b.type))} draggable="true" ondragstart={e=>{e.dataTransfer.setData("text/plain",b.id);blockDraggingId=b.id;}} ondragend={()=>blockDraggingId=null}>{CONFIG.CYCLE.includes(b.type)?CONFIG.BULLETS[b.type]:"::"}</div>
                  <textarea data-id={b.id} use:autoFocus={{id:b.id,focusId:activeFocusId,offset:activeCursorOffset}} class="{Utils.getBlockClasses(b.type)} resize-none overflow-hidden bg-transparent" rows="1" spellcheck="false" bind:value={b.text} use:autoResize={b.text} onkeydown={e=>EventController.handleKeydown(e)} oninput={e=>EditorEngine.updateText(b.id,e.target.value)}></textarea>
                </div>
              {/each}{/if}
            </div>
          </div>
          <div use:resizableRegion={r.id} class="region-resizer absolute bottom-0 right-0 w-5 h-5 cursor-se-resize flex items-end justify-end p-1 opacity-0 hover:opacity-100 transition-opacity"><div class="w-2 h-2 border-r-2 border-b-2 border-zinc-400 rounded-sm pointer-events-none"></div></div>
        </div>
      {/each}
      {#if isDrawingRegion&&tempRegion.surfaceId===pId}<div class="absolute border border-zinc-400 bg-white/20 rounded-lg pointer-events-none layer-focus" style="left:{tempRegion.x}px;top:{tempRegion.y}px;width:{tempRegion.w}px;height:{tempRegion.h}px"></div>{/if}
      {#each store.meta.placedImages.filter(img=>img.pageId===pId) as img (img.id)}
        {#if store.loadedImages[img.id]}
          <img src={store.loadedImages[img.id]} oncontextmenu={e=>{e.preventDefault();e.stopPropagation();contextMenuX=e.clientX;contextMenuY=e.clientY;contextMenuItems=[{label:"Delete Image 🗑️",danger:true,action:()=>store.removeImage(img.id)}];contextMenuVisible=true;}} class="draggable-image layer-{img.layerBucket||'sticker'} transition-transform duration-200 {zoomedImgId===img.id?'scale-125':'scale-100'}" data-img-id={img.id} data-page-id={img.pageId} data-locked={img.locked?"true":null} alt="placed" style="left:{img.left}px;top:{img.top}px;rotate:{img.rotation||0}deg;opacity:{img.opacity??1};" use:draggableImage={img}/>
        {/if}
      {/each}
    </div>
  {/each}
</div>

<div id="page-indicator" class="fixed bottom-2 left-1/2 -translate-x-1/2 flex gap-3 z-50 p-4 cursor-grab active:cursor-grabbing touch-none" onpointerdown={e=>{const i=e.currentTarget;i.setPointerCapture(e.pointerId);i._isScrubbing=true;isScrubbing=true;indicatorScrub(e,i);}} onpointermove={e=>{const i=e.currentTarget;if(i._isScrubbing)indicatorScrub(e,i);}} onpointerup={async e=>{const i=e.currentTarget;i._isScrubbing=false;isScrubbing=false;i.releasePointerCapture(e.pointerId);await store.executeSave();}} onclick={e=>{const d=e.target.closest(".indicator-dot");if(d)store.changePage(parseInt(d.dataset.idx),false);}}>
  {#each store.meta.pageOrder as _,i}
    <span data-idx={i} class="indicator-dot pointer-events-none h-2 rounded-full transition-all duration-300 {i===store.currentP?'w-6 bg-zinc-800':'w-2 bg-zinc-300 hover:bg-zinc-400'}"></span>
  {/each}
</div>

{#if contextMenuVisible}
  <div id="custom-context-menu" class="fixed bg-white border border-zinc-200 shadow-xl rounded-md py-1 z-[100] w-48" style="left:{contextMenuX}px;top:{contextMenuY}px">
    {#each contextMenuItems as item}
      <button class="w-full text-left px-3 py-1.5 hover:bg-zinc-100 text-sm {item.danger?'text-red-600':'text-zinc-800'}" onclick={e=>{e.stopPropagation();item.action();contextMenuVisible=false;}}>{item.label}</button>
    {/each}
  </div>
{/if}

<style>
:global(body){overflow-x:hidden;overflow-y:auto;background-color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}:global([contenteditable]:empty::before){content:"\FEFF"}.bullet-block{animation:slideIn 0.15s ease-out forwards;cursor:default}@keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}:global(::-webkit-scrollbar){display:none}.bullet-handle{cursor:grab;user-select:none}.bullet-handle:active{cursor:grabbing}.dragging{opacity:0.3}.bullet-text{cursor:text;user-select:text;word-break:break-word;-webkit-hyphens:auto;hyphens:auto}.region-content::-webkit-scrollbar{display:none}.draggable-image{position:absolute;top:0;left:0;cursor:grab;max-width:300px;filter:drop-shadow(0px 8px 12px rgba(0,0,0,0.15));user-select:none;transition:scale 0.2s ease,rotate 0.2s ease,opacity 0.2s ease}.draggable-image:active{cursor:grabbing}.draggable-image[data-locked="true"]{cursor:default}.draggable-image[data-locked="true"]:active{cursor:default}:global(.layer-background){z-index:10}:global(.layer-paper){z-index:20}:global(.layer-sticker){z-index:30}:global(.layer-floating){z-index:40}:global(.layer-focus){z-index:50}
</style>