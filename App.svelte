<script>
  import { onMount, tick } from "svelte";
  let isScrubbing=$state(false),zoomedImgId=$state(null),stickerDrawerOpen=$state(false),loadedStickers=$state([]),contextMenuVisible=$state(false),contextMenuX=$state(0),contextMenuY=$state(0),contextMenuItems=$state([]),isDrawingRegion=$state(false),tempRegion=$state({x:0,y:0,w:0,h:0}),blockDraggingId=$state(null),activeFocusId=$state(null),activeCursorOffset=$state(0),focusedRegionId=$state(null),activePackId=$state("all"),promptVisible=$state(false),promptTitle=$state(""),promptValue=$state(""),promptCallback=$state(null),packSelectorVisible=$state(false),packSelectorStickerId=$state(null),draggingStickerId=$state(null);
  const StickerCache = new Map();

  const CONFIG={BULLETS:{task:"•",completed:"✕",migrated:">",scheduled:"<",event:"○",note:"-"},CYCLE:["task","completed","migrated","scheduled","event","note"],MD_MAP:{"* ":"task","x ":"completed","> ":"migrated","< ":"scheduled","o ":"event","- ":"note","# ":"h1","## ":"h2","### ":"h3","#### ":"h4","##### ":"h5","###### ":"h6"},H_STYLES:{h1:"text-4xl font-bold mt-6 mb-2",h2:"text-3xl font-bold mt-5 mb-2",h3:"text-2xl font-bold mt-4 mb-1",h4:"text-xl font-semibold mt-3 mb-1",h5:"text-lg font-semibold mt-2 mb-1",h6:"text-base font-semibold uppercase tracking-wider mt-2 mb-1 text-zinc-500"},SAVE_TIMEOUT_MS:500,LAYERS:["background","paper","sticker","floating","focus"],OPACITIES:[1,0.75,0.5,0.25],INDENT_PX:28,MIN_REGION_SIZE:50,MAX_DEPTH:4};

  class BujoStore{
    meta=$state({pageOrder:[],stickers:[],placedImages:[],regions:[],stickerPacks:[],activePackId:"all"});
    pages=$state({});currentP=$state(0);loadedImages=$state({});
    blockMap=new Map();dirtyPages=new Set();isSaving=false;needsSave=false;saveTimeout=null;
    async init(){
      const m={version:4,currentP:0,pageOrder:[],stickers:[],placedImages:[],regions:[],stickerPacks:[],activePackId:"all",...(await FileSystemAPI.readJson("meta.json")||{})};
      if(!m.pageOrder.length){m.pageOrder.push(`page-${Utils.generateId()}`,`page-${Utils.generateId()}`);await FileSystemAPI.writeJsonAtomic("meta.json",m);}
      this.meta=m; this.currentP=m.currentP||0;
      await Promise.all(m.regions.map(async r=>{if(!this.pages[r.pageId])this.pages[r.pageId]=await FileSystemAPI.readJson(`pages/${r.pageId}.json`)||[this.createBlock()];}));
      this.rebuildIndex();
    }
    requestSave(){clearTimeout(this.saveTimeout);this.saveTimeout=setTimeout(()=>this.executeSave(),CONFIG.SAVE_TIMEOUT_MS);}
    async executeSave(){
      if(this.isSaving)return(this.needsSave=true); this.isSaving=true; this.needsSave=false;
      try{
        await this.cleanEmptySpreads(); this.meta.currentP=this.currentP;
        await FileSystemAPI.writeJsonAtomic("meta.json",$state.snapshot(this.meta));
        for(const p of new Set(this.dirtyPages)){if(this.pages[p])await FileSystemAPI.writeJsonAtomic(`pages/${p}.json`,$state.snapshot(this.pages[p]));}
        this.dirtyPages.clear();
      }catch(e){console.error(e);}finally{this.isSaving=false;if(this.needsSave)this.executeSave();}
    }
    createBlock=(text="",depth=0,type="text")=>({id:Utils.generateId(),type,text,depth});
    rebuildIndex(){this.blockMap.clear();Object.entries(this.pages).forEach(([p,b])=>b.forEach((blk,i)=>this.blockMap.set(blk.id,{pageId:p,bIdx:i,block:blk})));}
    getBlockCoords=(id)=>this.blockMap.get(id)||null;
    async cleanEmptySpreads(){
      let c=false;
      for(let i=this.meta.pageOrder.length-1;i>this.currentP;i--){
        const pId=this.meta.pageOrder[i];
        if(!this.meta.placedImages.some(i=>i.pageId===pId)&&!this.meta.regions.some(r=>r.surfaceId===pId)){
          delete this.pages[pId];this.meta.pageOrder.splice(i,1);this.meta.scrolls?.splice(i,1);c=true;
        }
      }
      if(this.currentP>=this.meta.pageOrder.length){this.currentP=Math.max(0,this.meta.pageOrder.length-1);c=true;}
      if(c)this.rebuildIndex(); return c;
    }
    async ensureEnoughPages(){if(this.currentP>=this.meta.pageOrder.length){this.meta.pageOrder.push(`page-${Utils.generateId()}`);this.rebuildIndex();await FileSystemAPI.writeJsonAtomic("meta.json",$state.snapshot(this.meta));return true;}return false;}
    updateBlock(id,u){const c=this.getBlockCoords(id);if(c){Object.assign(c.block,u);this.dirtyPages.add(c.pageId);this.requestSave();}}
    addBlock(nb,id){const c=this.getBlockCoords(id);if(c){this.pages[c.pageId].splice(c.bIdx+1,0,nb);this.rebuildIndex();this.dirtyPages.add(c.pageId);this.requestSave();}}
    removeBlock(id){const c=this.getBlockCoords(id);if(c){this.pages[c.pageId].splice(c.bIdx,1);this.rebuildIndex();this.dirtyPages.add(c.pageId);this.requestSave();}}
    moveBlockDOM(id,tId,ia){const src=this.getBlockCoords(id),tgt=this.getBlockCoords(tId);if(!src||!tgt)return;const [m]=this.pages[src.pageId].splice(src.bIdx,1),sA=src.pageId===tgt.pageId;this.pages[tgt.pageId].splice(tgt.bIdx-(sA&&src.bIdx<tgt.bIdx?1:0)+(ia?1:0),0,m);this.rebuildIndex();this.dirtyPages.add(src.pageId);if(!sA)this.dirtyPages.add(tgt.pageId);this.requestSave();}
    async changePage(d,isR=true){const nP=isR?this.currentP+d:d;if(nP<0)return;this.currentP=nP;await this.ensureEnoughPages();window.scrollTo({top:0,behavior:"smooth"});await this.executeSave();}
    async spawnImage(src,cX,cY){const id=Utils.generateId();await FileSystemAPI.writeJsonAtomic(`images/${id}.json`,{src});const img={id,pageId:this.meta.pageOrder[this.currentP],left:cX!==undefined?cX-50:100,top:cY!==undefined?cY-50:100,layerBucket:"sticker"};this.meta.placedImages.push(img);await this.executeSave();this.renderImage(img);}
    async renderImage(d){const f=await FileSystemAPI.readJson(`images/${d.id}.json`);if(f?.src)this.loadedImages[d.id]=f.src;}
    restoreAllImages(){this.meta.placedImages.forEach(d=>this.renderImage(d));}
    async removeImage(id){const idx=this.meta.placedImages.findIndex(i=>i.id===id);if(idx!==-1){this.meta.placedImages.splice(idx,1);await this.executeSave();delete this.loadedImages[id];FileSystemAPI.trashJson(`images/${id}.json`);}}
    async removeRegion(id){const idx=this.meta.regions.findIndex(r=>r.id===id);if(idx!==-1){const r=this.meta.regions[idx];this.meta.regions.splice(idx,1);delete this.pages[r.pageId];this.rebuildIndex();await this.executeSave();await FileSystemAPI.trashJson(`pages/${r.pageId}.json`);}}
  }
  const store=new BujoStore();

  function pointerAction(node,{onDown,onMove,onUp,ignore}){
    let a=false, d=e=>{if(e.button!==0||ignore?.(e))return;a=true;node.setPointerCapture(e.pointerId);onDown?.(e);}, m=e=>{if(a)onMove?.(e);}, u=e=>{if(!a)return;a=false;node.releasePointerCapture(e.pointerId);onUp?.(e);};
    const hs=[d,m,u,u], evs=["pointerdown","pointermove","pointerup","pointercancel"];
    evs.forEach((ev,i)=>node.addEventListener(ev,hs[i]));
    return{destroy:()=>evs.forEach((ev,i)=>node.removeEventListener(ev,hs[i]))};
  }
  function dragBehavior(node, { getObj, keys, min=[-Infinity,-Infinity] }) {
    let sX, sY, iX, iY;
    return pointerAction(node, {
      ignore: () => getObj()?.locked,
      onDown: e => { const o = getObj(); if(o) { sX = e.clientX; sY = e.clientY; iX = o[keys[0]]; iY = o[keys[1]]; e.preventDefault(); e.stopPropagation(); } },
      onMove: e => { const o = getObj(); if(o) { o[keys[0]] = Math.max(min[0], iX + e.clientX - sX); o[keys[1]] = Math.max(min[1], iY + e.clientY - sY); } },
      onUp: () => store.requestSave()
    });
  }

  const Utils={
    generateId:()=>crypto.randomUUID(), clamp:(v,m,x)=>Math.max(m,Math.min(x,v)), calcRectOffset:(cX,cY,r)=>({x:cX-r.left,y:cY-r.top}),
    getBlockClasses:t=>`flex-1 outline-none whitespace-pre-wrap min-h-[1.5rem] bullet-text transition-all duration-300 ${CONFIG.H_STYLES[t]||"text-[1.05rem] leading-relaxed"} ${t==="completed"?"line-through text-zinc-400 opacity-60":["migrated","scheduled"].includes(t)?"italic text-zinc-500":""}`.trim(),
    getHandleClasses:isB=>`absolute -left-8 top-0.5 w-7 h-7 flex items-center justify-center bullet-handle ${isB?"opacity-100 text-zinc-500":"opacity-0 text-zinc-300"} group-hover:opacity-100 hover:!text-black font-bold transition-all`,
    getNextType:cT=>CONFIG.CYCLE[(CONFIG.CYCLE.indexOf(cT)+1)%CONFIG.CYCLE.length]||"task",
    getNextLayer:(cL,d)=>CONFIG.LAYERS[Utils.clamp(CONFIG.LAYERS.indexOf(cL)+d,0,CONFIG.LAYERS.length-1)],
    getNextOpacity:cO=>CONFIG.OPACITIES[(CONFIG.OPACITIES.indexOf(cO??1)+1)%CONFIG.OPACITIES.length],
    qsa:s=>document.querySelectorAll(s)
  };
  const api=window.electronAPI, memFs=new Map(), FileSystemAPI={
    readJson:async p=>api?await api.readJson(p):memFs.get(p)??null, writeJsonAtomic:async(p,d)=>api?await api.writeJsonAtomic(p,d):memFs.set(p,d), trashJson:async p=>api?await api.trashJson(p):memFs.delete(p)
  };

  const StickerBookManager = {
    async update(fn){ fn(); await store.executeSave(); this.render(); },
    async saveSticker(b64){ const id=Utils.generateId(); await FileSystemAPI.writeJsonAtomic(`images/sticker-${id}.json`,{src:b64}); StickerCache.set(id,b64); this.update(()=>{ store.meta.stickers=[...(store.meta.stickers||[]),id]; if(activePackId!=="all") store.meta.stickerPacks?.forEach(p=>{if(p.id===activePackId)p.stickers=[...(p.stickers||[]),id];}); }); },
    async removeSticker(id){ this.update(()=>{ store.meta.stickers=store.meta.stickers?.filter(s=>s!==id); store.meta.stickerPacks?.forEach(p=>p.stickers=p.stickers?.filter(s=>s!==id)); }); StickerCache.delete(id); await FileSystemAPI.trashJson(`images/sticker-${id}.json`); },
    async loadSticker(id){ if(StickerCache.has(id))return{id,src:StickerCache.get(id)}; const f=await FileSystemAPI.readJson(`images/sticker-${id}.json`); if(f?.src){StickerCache.set(id,f.src);return{id,src:f.src};} return null; },
    async render(){ const l = activePackId==="all" ? store.meta.stickers : store.meta.stickerPacks?.find(p=>p.id===activePackId)?.stickers; loadedStickers=(await Promise.all((l||[]).map(id=>this.loadSticker(id)))).filter(Boolean); },
    async createPack(name){ if(!name?.trim())return; const id=`pack-${Utils.generateId()}`; this.update(()=>{ store.meta.stickerPacks=[...(store.meta.stickerPacks||[]),{id,name:name.trim(),stickers:[]}]; store.meta.activePackId=activePackId=id; }); },
    async renamePack(pId,name){ this.update(()=>store.meta.stickerPacks?.forEach(p=>{if(p.id===pId)p.name=name.trim();})); },
    async deletePack(pId){ this.update(()=>{ store.meta.stickerPacks=store.meta.stickerPacks?.filter(p=>p.id!==pId); if(activePackId===pId) store.meta.activePackId=activePackId="all"; }); },
    async toggleStickerInPack(sId,pId){ this.update(()=>store.meta.stickerPacks?.forEach(p=>{if(p.id===pId){const s=p.stickers||[]; p.stickers=s.includes(sId)?s.filter(id=>id!==sId):[...s,sId];}})); }
  };

  const RegionManager={
    startX:0,startY:0,surfaceId:null,
    start(e){const w=e.target.closest(".page-wrapper");if(!w)return;isDrawingRegion=true;this.surfaceId=w.dataset.pageId;const {x,y}=Utils.calcRectOffset(e.clientX,e.clientY,w.getBoundingClientRect());this.startX=x;this.startY=y;tempRegion={x,y,w:0,h:0,surfaceId:this.surfaceId};},
    draw(e){if(!isDrawingRegion)return;const w=[...Utils.qsa(".page-wrapper")].find(w=>w.dataset.pageId===this.surfaceId);if(!w)return;const {x,y}=Utils.calcRectOffset(e.clientX,e.clientY,w.getBoundingClientRect());tempRegion={...tempRegion,x:Math.min(this.startX,x),y:Math.min(this.startY,y),w:Math.abs(x-this.startX),h:Math.abs(y-this.startY)};},
    async stop(){if(!isDrawingRegion)return;isDrawingRegion=false;if(tempRegion.w>CONFIG.MIN_REGION_SIZE&&tempRegion.h>CONFIG.MIN_REGION_SIZE){const pId=`page-${Utils.generateId()}`,nb=store.createBlock();store.meta.regions.push({id:Utils.generateId(),surfaceId:this.surfaceId,x:tempRegion.x,y:tempRegion.y,width:tempRegion.w,height:tempRegion.h,pageId:pId});store.pages[pId]=[nb];store.rebuildIndex();store.dirtyPages.add(pId);await store.executeSave();activeFocusId=nb.id;activeCursorOffset=0;}}
  };

  const EditorEngine={
    update(id,u){store.updateBlock(id,u);},
    indent(id,d){const c=store.getBlockCoords(id);if(c)this.update(id,{depth:Utils.clamp(c.block.depth+d,0,CONFIG.MAX_DEPTH)});},
    updateText(id,cT){
      const c=store.getBlockCoords(id);if(!c)return;
      let pT=cT.replace(/\u00A0/g," "), md=Object.entries(CONFIG.MD_MAP).find(([p])=>pT.startsWith(p));
      if(md){this.update(id,{text:pT.substring(md[0].length),type:md[1]});activeFocusId=id;activeCursorOffset=0;}else this.update(id,{text:cT});
    },
    split(id,cP){const c=store.getBlockCoords(id);if(!c)return;const {block:b}=c,nT=b.type.startsWith("h")?"text":b.type,nb=store.createBlock(b.text.slice(cP),b.depth,nT);this.update(id,{text:b.text.slice(0,cP)});store.addBlock(nb,id);activeFocusId=nb.id;activeCursorOffset=0;},
    merge(id){const c=store.getBlockCoords(id);if(!c||c.bIdx===0)return;const p=store.pages[c.pageId][c.bIdx-1],mP=p.text.length;this.update(p.id,{text:p.text+c.block.text});store.removeBlock(id);activeFocusId=p.id;activeCursorOffset=mP;},
    nav(id,d){const c=store.getBlockCoords(id),t=c&&store.pages[c.pageId][c.bIdx+d];if(t){activeFocusId=t.id;activeCursorOffset=0;}}
  };

  let scrubTimeout;
  function indicatorScrub(e,ind){
    const r=ind.getBoundingClientRect(),pC=store.meta.pageOrder.length;if(pC<=1)return;
    const idx=Utils.clamp(Math.floor((Utils.clamp(e.clientX-r.left,0,r.width)/r.width)*pC),0,pC-1);
    if(store.currentP!==idx){store.currentP=idx;clearTimeout(scrubTimeout);scrubTimeout=setTimeout(()=>store.changePage(idx,false),50);}
  }
  function autoResize(node){const r=()=>{node.style.height="auto";node.style.height=node.scrollHeight+"px";};node.addEventListener("input",r);setTimeout(r,0);return{update:r,destroy:()=>node.removeEventListener("input",r)};}
  function autoFocus(node,{id,focusId,offset}){$effect(()=>{if(id===focusId){node.focus();const tP=Math.min(offset,node.value.length);node.setSelectionRange(tP,tP);activeFocusId=null;}});}

  const globalKey=e=>{const isI=["TEXTAREA","INPUT"].includes(document.activeElement?.tagName),l=e.key==="ArrowLeft",r=e.key==="ArrowRight";if((l||r)&&(!isI||e.altKey)){e.preventDefault();store.changePage(l?-1:1,true);}};
  const showCustomPrompt=(t,d,cb)=>{promptTitle=t;promptValue=d||"";promptCallback=cb;promptVisible=true;setTimeout(()=>document.getElementById("custom-prompt-input")?.select(),50);};
  const openCtx=(e,items)=>{e.preventDefault();e.stopPropagation();contextMenuX=e.clientX;contextMenuY=e.clientY;contextMenuItems=items;contextMenuVisible=true;};
  const tDrop=(e,on)=>{if(draggingStickerId&&draggingStickerId!=="all")e.currentTarget.classList[on?'add':'remove']("!bg-zinc-800","!text-white","scale-105","!border-zinc-800");};
  const packBtnClass=id=>`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 active:scale-95 border ${activePackId===id?'bg-zinc-900 text-white border-zinc-900 shadow-sm':'bg-zinc-50 hover:bg-zinc-100 text-zinc-600 border-zinc-200/50'}`;

  $effect(()=>activePackId&&StickerBookManager.render());
  onMount(()=>{
    let d=false; (async()=>{await store.init();if(d)return;activePackId=store.meta.activePackId||"all";StickerBookManager.render();store.restoreAllImages();})();
    window.addEventListener("beforeunload",()=>store.saveTimeout&&store.executeSave());
    return()=>d=true;
  });
</script>

<svelte:window onclick={()=>contextMenuVisible=false} onkeydown={globalKey} onpointerup={()=>draggingStickerId=null}/>
<button class="fixed top-6 right-6 w-12 h-12 bg-zinc-900 text-white rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.15)] text-2xl z-[60] hover:scale-110 active:scale-95 hover:bg-zinc-800 transition-all duration-300 flex items-center justify-center border border-zinc-800" onclick={()=>stickerDrawerOpen=!stickerDrawerOpen}>🎒</button>

<div class="fixed top-0 right-0 w-[340px] h-screen bg-white/90 backdrop-blur-lg shadow-[-10px_0_40px_rgba(0,0,0,0.04)] z-[50] transform transition-transform duration-500 ease-out border-l border-zinc-200/60 p-6 overflow-y-auto {stickerDrawerOpen?'translate-x-0':'translate-x-full'}">
  <div class="flex items-center justify-between mb-2 mt-16"><h2 class="text-2xl font-extrabold text-zinc-800 tracking-tight">Stickers 🌟</h2><span class="text-xs font-semibold px-2 py-0.5 bg-zinc-100 text-zinc-600 rounded-full border border-zinc-200/60 shadow-sm">{loadedStickers.length}</span></div>
  <p class="text-xs text-zinc-500 mb-5 leading-relaxed">Double-click any floating image on your page to save it here! Or upload new ones directly 👇 💡 <b>Drag stickers onto tabs</b> to organize them, or right-click for options.</p>

  <div class="flex flex-wrap gap-1.5 items-center mb-6 pb-2 border-b border-zinc-100">
    <button class={packBtnClass('all')} onclick={()=>{activePackId='all';store.meta.activePackId='all';store.requestSave();}} onpointerenter={e=>tDrop(e,1)} onpointerleave={e=>tDrop(e,0)} onpointerup={e=>{tDrop(e,0);draggingStickerId=null;}}>All</button>
    {#each store.meta.stickerPacks||[] as pack (pack.id)}
      <button class={packBtnClass(pack.id)} onclick={()=>{activePackId=pack.id;store.meta.activePackId=pack.id;store.requestSave();}} onpointerenter={e=>tDrop(e,1)} onpointerleave={e=>tDrop(e,0)} onpointerup={e=>{tDrop(e,0);if(draggingStickerId){StickerBookManager.toggleStickerInPack(draggingStickerId,pack.id);draggingStickerId=null;}}} oncontextmenu={e=>openCtx(e,[{label:"Rename Pack ✏️",action:()=>showCustomPrompt("Rename Sticker Pack ✏️",pack.name,n=>StickerBookManager.renamePack(pack.id,n))},{label:"Delete Pack 🗑️",danger:true,action:()=>StickerBookManager.deletePack(pack.id)}])} title="Right-click to rename/delete. Drag stickers here to add.">{pack.name}</button>
    {/each}
    <button class="w-7 h-7 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 flex items-center justify-center text-sm font-bold border border-zinc-200/60 active:scale-95 transition-all duration-200" onclick={()=>showCustomPrompt("Create New Sticker Pack 📁","",n=>StickerBookManager.createPack(n))} title="Create New Sticker Pack">＋</button>
  </div>

  <label class="block w-full cursor-pointer bg-zinc-900 text-white hover:bg-zinc-800 text-center py-3 rounded-xl font-medium text-sm mb-6 transition-all duration-300 hover:shadow-md active:scale-[0.98] border border-transparent">➕ Upload Sticker<input type="file" accept="image/*" class="hidden" onchange={e=>{const f=e.target.files[0];if(f){const r=new FileReader();r.onload=ev=>StickerBookManager.saveSticker(ev.target.result);r.readAsDataURL(f);}}}/></label>

  <div class="grid grid-cols-2 gap-4">
    {#if !loadedStickers.length} <div class="col-span-2 text-center text-sm text-zinc-400 mt-4">No stickers saved yet! 😿</div> {/if}
    {#each loadedStickers as s (s.id)}
      <div class="relative cursor-grab active:cursor-grabbing group flex items-center justify-center p-3 bg-white/60 hover:bg-white rounded-2xl shadow-sm border border-zinc-200/50 transition-all duration-300 {draggingStickerId===s.id?'opacity-40 scale-95':'hover:-translate-y-0.5'}" onpointerdown={e=>{e.preventDefault();draggingStickerId=s.id;}} onclick={()=>store.spawnImage(s.src)} oncontextmenu={e=>openCtx(e,[{label:"Manage Packs... 📂",action:()=>{packSelectorStickerId=s.id;packSelectorVisible=true;}},...(activePackId!=="all"?[{label:`Remove from Pack ❌`,action:()=>StickerBookManager.toggleStickerInPack(s.id,activePackId)}]:[]),{label:"Delete Globally 🗑️",danger:true,action:()=>{if(confirm("Delete permanently?"))StickerBookManager.removeSticker(s.id);}}])}>
        <img src={s.src} draggable="false" class="max-w-full max-h-24 object-contain filter drop-shadow-sm group-hover:drop-shadow-md" alt="sticker"/>
        <button class="absolute top-1.5 right-1.5 w-5 h-5 bg-red-50 hover:bg-red-100 border border-red-200 text-red-500 rounded-full flex items-center justify-center text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-opacity duration-200" onclick={e=>{e.stopPropagation();activePackId==="all"?(confirm("Delete globally?")&&StickerBookManager.removeSticker(s.id)):StickerBookManager.toggleStickerInPack(s.id,activePackId);}}>✕</button>
      </div>
    {/each}
  </div>
</div>

<div class="flex w-full min-h-screen will-change-transform relative items-start {isScrubbing?'!transition-none':'transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]'}" style="transform: translateX(-{store.currentP*100}vw)">
  {#each store.meta.pageOrder as pId,i (pId)}
    <div class="page-wrapper w-[100vw] min-h-screen flex-shrink-0 relative flex justify-center overflow-hidden" data-page-id={pId} use:pointerAction={{ignore:e=>["TEXTAREA","BUTTON"].includes(e.target.tagName)||e.target.classList.contains("bullet-text")||e.target.closest(".region-box")||e.target.closest(".draggable-image")||e.target.closest("#page-indicator"),onDown:e=>RegionManager.start(e),onMove:e=>RegionManager.draw(e),onUp:()=>RegionManager.stop()}} onpointerup={e=>{if(draggingStickerId){const s=loadedStickers.find(st=>st.id===draggingStickerId);if(s){const r=e.currentTarget.getBoundingClientRect();store.spawnImage(s.src,e.clientX-r.left,e.clientY-r.top);}draggingStickerId=null;}}} ondragover={e=>e.preventDefault()} ondrop={e=>{e.preventDefault();try{const d=JSON.parse(e.dataTransfer.getData("application/json"));if(d?.type==="sticker"){const r=e.currentTarget.getBoundingClientRect();store.spawnImage(d.src,e.clientX-r.left,e.clientY-r.top);}}catch(err){}}}>
      <div class="absolute bottom-8 left-0 w-full text-center text-zinc-400 text-sm font-mono tracking-widest select-none pointer-events-none">{i+1}</div>
      {#each store.meta.regions.filter(r=>r.surfaceId===pId) as r (r.id)}
        <div class="region-box absolute bg-zinc-50/80 hover:bg-zinc-100/80 border transition-colors duration-300 rounded-lg flex flex-col layer-paper {focusedRegionId===r.id?'bg-white border-zinc-800 shadow-md ring-1 ring-zinc-800/10':'border-zinc-300 hover:border-zinc-400 shadow-sm'}" data-locked={r.locked} style="left:{r.x}px;top:{r.y}px;width:{r.width}px;height:{r.height}px" oncontextmenu={e=>openCtx(e,[{label:r.locked?"Unlock Position 🔓":"Lock Position 🔒",action:()=>{r.locked=!r.locked;store.requestSave();}},{label:"Clear Content 🧹",action:()=>{if(confirm("Clear content?")){store.pages[r.pageId]=[store.createBlock()];store.rebuildIndex();store.dirtyPages.add(r.pageId);store.requestSave();}}},{label:"Delete Region 🗑️",danger:true,action:()=>{if(confirm("Delete region?"))store.removeRegion(r.id);}}])}>
          <div use:dragBehavior={{getObj:()=>store.meta.regions.find(x=>x.id===r.id),keys:['x','y']}} class="h-5 bg-transparent {r.locked?'cursor-default':'cursor-grab active:cursor-grabbing'} rounded-t-lg flex items-center px-2 hover:bg-black/5 transition-colors group"></div>
          <div class="flex-1 overflow-y-auto py-4 pr-4 pl-10 cursor-text" style="touch-action: pan-y;">
            <div class="min-h-full" ondragover={e=>e.preventDefault()} ondragend={()=>blockDraggingId=null} ondrop={e=>{e.preventDefault();const dId=e.dataTransfer.getData("text/plain"),tB=e.target.closest(".bullet-block");if(dId&&tB){const r=tB.getBoundingClientRect();store.moveBlockDOM(dId,tB.dataset.id,e.clientY>r.top+r.height/2);}blockDraggingId=null;}}>
              {#if store.pages[r.pageId]}{#each store.pages[r.pageId] as b (b.id)}
                <div class="relative flex items-start mb-2 bullet-block group {blockDraggingId===b.id?'dragging':''}" data-id={b.id} style="margin-left:{b.depth*CONFIG.INDENT_PX}px" draggable={blockDraggingId===b.id} ondragstart={e=>{const id=e.target.closest(".bullet-block")?.dataset?.id;if(id)blockDraggingId=id;}}>
                  <div class={Utils.getHandleClasses(CONFIG.CYCLE.includes(b.type))} draggable="true" ondragstart={e=>{e.dataTransfer.setData("text/plain",b.id);blockDraggingId=b.id;}} ondragend={()=>blockDraggingId=null}>{CONFIG.CYCLE.includes(b.type)?CONFIG.BULLETS[b.type]:"::"}</div>
                  <textarea use:autoFocus={{id:b.id,focusId:activeFocusId,offset:activeCursorOffset}} class="{Utils.getBlockClasses(b.type)} resize-none overflow-hidden bg-transparent" rows="1" spellcheck="false" bind:value={b.text} use:autoResize onkeydown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();EditorEngine.split(b.id,e.target.selectionStart);}if(e.key==="Backspace"&&!e.target.selectionStart){e.preventDefault();EditorEngine.merge(b.id);}if(e.key==="Tab"){e.preventDefault();EditorEngine.indent(b.id,e.shiftKey?-1:1);}if(e.key==="ArrowUp"){e.preventDefault();EditorEngine.nav(b.id,-1);}if(e.key==="ArrowDown"){e.preventDefault();EditorEngine.nav(b.id,1);}}} oninput={e=>EditorEngine.updateText(b.id,e.target.value)} onfocus={()=>focusedRegionId=r.id} onblur={()=>{if(focusedRegionId===r.id)focusedRegionId=null;}}></textarea>
                </div>
              {/each}{/if}
            </div>
          </div>
          {#if !r.locked}<div use:dragBehavior={{getObj:()=>store.meta.regions.find(x=>x.id===r.id),keys:['width','height'],min:[CONFIG.MIN_REGION_SIZE,CONFIG.MIN_REGION_SIZE]}} class="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize flex items-end justify-end p-1 opacity-0 hover:opacity-100 transition-opacity"><div class="w-2 h-2 border-r-2 border-b-2 border-zinc-400 rounded-sm pointer-events-none"></div></div>{/if}
        </div>
      {/each}
      {#if isDrawingRegion&&tempRegion.surfaceId===pId}<div class="absolute border border-zinc-400 bg-white/20 rounded-lg pointer-events-none layer-focus" style="left:{tempRegion.x}px;top:{tempRegion.y}px;width:{tempRegion.w}px;height:{tempRegion.h}px"></div>{/if}
      {#each store.meta.placedImages.filter(img=>img.pageId===pId) as img (img.id)}
        {#if store.loadedImages[img.id]}
          <img src={store.loadedImages[img.id]} oncontextmenu={e=>openCtx(e,[{label:img.locked?"Unlock Position 🔓":"Lock Position 🔒",action:()=>{img.locked=!img.locked;store.requestSave();}},{label:`Opacity: ${Math.round((img.opacity??1)*100)}% 💧`,action:()=>{img.opacity=Utils.getNextOpacity(img.opacity);store.requestSave();}},{label:"Rotate (45°) 🔄",action:()=>{img.rotation=((img.rotation||0)+45)%360;store.requestSave();}},{label:`Layer: ${img.layerBucket||'sticker'} 📑`,action:()=>{img.layerBucket=Utils.getNextLayer(img.layerBucket||'sticker',1);store.requestSave();}},{label:"Delete Image 🗑️",danger:true,action:()=>store.removeImage(img.id)}])} ondblclick={async e=>{e.stopPropagation();const src=store.loadedImages[img.id];if(src){await StickerBookManager.saveSticker(src);const btn=document.querySelector(".fixed.top-6");if(btn){btn.classList.add("animate-bounce");setTimeout(()=>btn.classList.remove("animate-bounce"),1000);}}}} class="draggable-image layer-{img.layerBucket||'sticker'} transition-transform duration-200 {zoomedImgId===img.id?'scale-125':'scale-100'}" data-locked={img.locked} alt="placed" style="left:{img.left}px;top:{img.top}px;rotate:{img.rotation||0}deg;opacity:{img.opacity??1};" use:dragBehavior={{getObj:()=>img,keys:['left','top']}}/>
        {/if}
      {/each}
    </div>
  {/each}
</div>

<div id="page-indicator" class="fixed bottom-6 left-1/2 -translate-x-1/2 flex gap-3 z-50 px-6 py-3.5 bg-zinc-100/90 backdrop-blur-md border border-zinc-300 rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.12)] cursor-grab active:cursor-grabbing touch-none items-center" onpointerdown={e=>{const i=e.currentTarget;i.setPointerCapture(e.pointerId);i._isScrubbing=true;isScrubbing=true;indicatorScrub(e,i);}} onpointermove={e=>{const i=e.currentTarget;if(i._isScrubbing)indicatorScrub(e,i);}} onpointerup={async e=>{const i=e.currentTarget;i._isScrubbing=false;isScrubbing=false;i.releasePointerCapture(e.pointerId);await store.executeSave();}} onclick={e=>{const d=e.target.closest(".indicator-dot");if(d)store.changePage(parseInt(d.dataset.idx),false);}}>
  {#each store.meta.pageOrder as _,i} <span data-idx={i} class="indicator-dot pointer-events-none h-2.5 rounded-full transition-all duration-300 {i===store.currentP?'w-7 bg-zinc-800':'w-2.5 bg-zinc-300 hover:bg-zinc-400'}"></span> {/each}
</div>

{#if contextMenuVisible}
  <div class="fixed bg-white border border-zinc-200 shadow-xl rounded-md py-1 z-[100] w-48" style="left:{contextMenuX}px;top:{contextMenuY}px">
    {#each contextMenuItems as item} <button class="w-full text-left px-3 py-1.5 hover:bg-zinc-100 text-sm {item.danger?'text-red-600':'text-zinc-800'}" onclick={e=>{e.stopPropagation();item.action();contextMenuVisible=false;}}>{item.label}</button> {/each}
  </div>
{/if}

{#if promptVisible}
  <div class="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center transition-all duration-300">
    <div class="bg-white rounded-2xl shadow-2xl border border-zinc-200 p-6 w-[360px] animate-[slideIn_0.2s_ease-out_forwards]">
      <h3 class="text-lg font-bold text-zinc-800 mb-3">{promptTitle}</h3>
      <input id="custom-prompt-input" type="text" bind:value={promptValue} class="w-full bg-zinc-50 border border-zinc-200 text-zinc-800 rounded-xl px-3 py-2.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-zinc-800/10 focus:border-zinc-800 transition-all duration-300 mb-4" placeholder="Enter pack name..." onkeydown={e=>{if(e.key==="Enter"){e.preventDefault();promptCallback?.(promptValue);promptVisible=false;}else if(e.key==="Escape"){e.preventDefault();promptVisible=false;}}}/>
      <div class="flex gap-2 justify-end">
        <button class="px-4 py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 rounded-xl text-xs font-semibold active:scale-95 transition-all duration-200" onclick={()=>promptVisible=false}>Cancel</button>
        <button class="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl text-xs font-semibold active:scale-95 transition-all duration-200" onclick={()=>{promptCallback?.(promptValue);promptVisible=false;}}>Save</button>
      </div>
    </div>
  </div>
{/if}

{#if packSelectorVisible}
  <div class="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center transition-all duration-300">
    <div class="bg-white rounded-2xl shadow-2xl border border-zinc-200 p-6 w-[360px] animate-[slideIn_0.2s_ease-out_forwards]">
      <div class="flex items-center justify-between mb-4"><h3 class="text-lg font-bold text-zinc-800">Manage Sticker Packs 📂</h3><button class="w-6 h-6 flex items-center justify-center rounded-full hover:bg-zinc-100 text-zinc-400 transition-colors" onclick={()=>packSelectorVisible=false}>✕</button></div>
      <p class="text-xs text-zinc-500 mb-4">Select which custom packs should include this sticker:</p>
      <div class="space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
        {#if !store.meta.stickerPacks?.length} <div class="text-center py-6 text-sm text-zinc-400 border border-dashed border-zinc-200 rounded-xl">No custom packs created yet! 📁</div>
        {:else} {#each store.meta.stickerPacks as pack (pack.id)}
          {@const isM=pack.stickers?.includes(packSelectorStickerId)}
          <button class="w-full flex items-center justify-between p-3 rounded-xl border text-sm font-semibold transition-all duration-200 active:scale-[0.98] {isM?'bg-zinc-900 text-white border-zinc-900 shadow-sm':'bg-zinc-50 hover:bg-zinc-100 text-zinc-700 border-zinc-200/50'}" onclick={()=>StickerBookManager.toggleStickerInPack(packSelectorStickerId,pack.id)}>
            <span>{pack.name}</span> <span class={isM?"text-xs font-bold bg-white/20 px-2 py-0.5 rounded-full":"text-xs text-zinc-400"}>{isM?"✓ Added":"＋ Add"}</span>
          </button>
        {/each} {/if}
      </div>
      <div class="mt-6 flex justify-end"><button class="px-5 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl text-xs font-semibold active:scale-95 transition-all duration-200 shadow-sm" onclick={()=>packSelectorVisible=false}>Done</button></div>
    </div>
  </div>
{/if}

<style>
:global(body){overflow-x:hidden;overflow-y:auto;background-color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}:global([contenteditable]:empty::before){content:"\FEFF"}.bullet-block{animation:slideIn 0.15s ease-out forwards;cursor:default}@keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}:global(::-webkit-scrollbar){display:none}.bullet-handle{cursor:grab;user-select:none}.bullet-handle:active{cursor:grabbing}.dragging{opacity:0.3}.bullet-text{cursor:text;user-select:text;word-break:break-word;-webkit-hyphens:auto;hyphens:auto}.draggable-image{position:absolute;top:0;left:0;cursor:grab;max-width:300px;filter:drop-shadow(0px 8px 12px rgba(0,0,0,0.15));user-select:none;transition:scale 0.2s ease,rotate 0.2s ease,opacity 0.2s ease}.draggable-image:active{cursor:grabbing}.draggable-image[data-locked="true"]{cursor:default}:global(.layer-background){z-index:10}:global(.layer-paper){z-index:20}:global(.layer-sticker){z-index:30}:global(.layer-floating){z-index:40}:global(.layer-focus){z-index:50}
</style>
