"use strict";

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const h = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const paths = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  book:'<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3V4zm9 3a3 3 0 0 1 3-3h6v15h-5a4 4 0 0 0-4 2"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>', back:'<path d="M19 12H5m6-6-6 6 6 6"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2"/>',
  code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20"/>',
  moon:'<path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  alert:'<path d="m12 3 10 18H2L12 3zM12 9v5m0 3v1"/>',expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  settings:'<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
$$('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
const main = $("#main");
const state = {controller:null, observer:null, comic:null, reader:null, headers:{}, chapters:new Map(), blobs:[], readerLight:false, catalog:null};
const collections = {latest:"Mới cập nhật",popular:"Nhiều lượt xem",completed:"Hoàn thành",ongoing:"Còn tiếp",favorites:"Nhiều lượt lưu"};
const fmt = n => n == null ? "—" : new Intl.NumberFormat("vi-VN",{notation:"compact",maximumFractionDigits:1}).format(n);
const fullId = comic => comic.slug || comic.id;
const route = (path, query={}) => "#"+path+(Object.keys(query).length?"?"+new URLSearchParams(query):"");
const comicLink = id => route("/comic/"+encodeURIComponent(id));
const readLink = (id,number) => route("/read/"+encodeURIComponent(id)+"/"+encodeURIComponent(number));
const safeURL = value => { if(!value)return "";try{const u=new URL(value,location.origin);return ["http:","https:"].includes(u.protocol)?u.href:"";}catch{return "";} };
function toast(message){const node=$("#toast");node.textContent=message;node.classList.add("visible");clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>node.classList.remove("visible"),3000);}
async function json(path,options={}){
  const response=await fetch(path,{...options,headers:{Accept:"application/json",...state.headers,...(options.body?{"Content-Type":"application/json"}:{}),...options.headers}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){let message=data.detail || `Yêu cầu thất bại (HTTP ${response.status})`;if(Array.isArray(message))message=message.map(e=>e.msg || "Tham số không hợp lệ").join("; ");if(response.status===401)message+=" Mở Kết nối API nếu máy chủ yêu cầu API key.";throw new Error(message);}
  return data;
}
const schemaPromise=json("/openapi.json").then(schema=>{$("#api-status").textContent=`API v${schema.info.version}`;return schema;}).catch(()=>null);
function historyItems(){try{const data=JSON.parse(localStorage.getItem("moetruyen:history") || "[]");return Array.isArray(data)?data.filter(x=>x&&typeof x.slug==="string"&&typeof x.title==="string").slice(0,30):[];}catch{return [];}}
function saveHistory(comic,number,title){try{const item={id:comic.id,slug:fullId(comic),title:comic.title,thumbnail_url:comic.thumbnail_url,number:String(number),chapter_title:title};localStorage.setItem("moetruyen:history",JSON.stringify([item,...historyItems().filter(x=>x.slug!==item.slug)].slice(0,30)));}catch{}}
function cover(card,eager=false){const raw=[...new Set([card.thumbnail_url,...(card.thumbnail_fallback_urls || []),...(card.cover_urls || [])].map(safeURL).filter(Boolean))];const urls=window.MoeCovers.candidates(raw);const first=urls.shift();return `<div class="cover"><div class="cover-placeholder">${icon("book")}</div>${first?`<img src="${h(first)}" alt="Bìa ${h(card.title)}" width="300" height="400" loading="${eager?"eager":"lazy"}" fetchpriority="${eager?"high":"auto"}" decoding="async" referrerpolicy="no-referrer" data-cover data-cover-primary="${h(raw[0])}" data-fallback="${h(JSON.stringify(urls))}">`:""}${card.adult?'<span class="cover-label">18+</span>':""}</div>`;}
document.addEventListener("error",event=>{
  const image=event.target;if(!(image instanceof HTMLImageElement)||image.dataset.fallback===undefined)return;
  if(image.hasAttribute("data-cover"))return;
  if(image.hasAttribute("data-api-image"))return;
  let urls=[];try{urls=JSON.parse(image.dataset.fallback);}catch{}
  if(urls.length){image.src=urls.shift();image.dataset.fallback=JSON.stringify(urls);return;}
  if(image.hasAttribute("data-page-image")){
    image.hidden=true;if(image.parentElement.querySelector(".image-error"))return;
    const box=document.createElement("div");box.className="image-error";
    box.innerHTML=`${icon("alert")}<p>Ảnh chưa tải được từ nguồn.</p><button class="button small">Thử lại</button>`;
    image.parentElement.append(box);$("button",box).onclick=()=>{box.remove();image.hidden=false;image.src=image.getAttribute("src");};
  }else image.remove();
},true);
function cardHTML(card,index=9,history=false){const id=fullId(card);const teams=(card.translation_teams || []).map(t=>typeof t==="string"?t:t.name).filter(Boolean).join(", ");return `<article class="manga-card"><a href="${h(history?readLink(id,card.number):comicLink(id))}">${cover(card,index<6)}<h3 class="card-title">${h(card.title)}</h3><div class="card-meta"><span class="chapter-label">${h(history?`Chương ${card.number}`:card.latest_chapter?.label || card.status || "Xem truyện")}</span><span>${fmt(card.views)}</span></div>${teams?`<p class="card-team" title="${h(teams)}">${h(teams)}</p>`:""}${card.description?`<p class="card-description">${h(card.description)}</p>`:""}</a></article>`;}
function skeletons(){return Array.from({length:12},()=>'<div><div class="skeleton skeleton-cover"></div><div class="skeleton skeleton-line"></div></div>').join("");}
function errorHTML(error,title="Chưa tải được dữ liệu"){return `<div class="empty-state"><div class="error-icon">${icon("alert")}</div><h2>${h(title)}</h2><p>${h(error.message || error)}</p><button class="button primary" data-retry>${icon("refresh")}Thử lại</button></div>`;}
function retry(){ $("[data-retry]")?.addEventListener("click",renderRoute); }
function heroHTML(){return `<section class="hero"><div><div class="eyebrow"><span class="live-dot"></span> THƯ VIỆN MÒE TRUYỆN</div><h1>Tìm một câu chuyện.<br><span>Ở lại thêm một chương.</span></h1><p>Khám phá truyện mới, gặp nhóm dịch bạn yêu thích. Đọc chương, lưu hành trình và thử API ngay tại đây.</p><div class="hero-actions"><a class="button primary" href="#/catalog">${icon("book")}Toàn bộ danh mục</a><a class="subtle" href="#/api">Khám phá API ${icon("arrow")}</a></div></div><div class="terminal"><div class="terminal-bar"><i></i><i></i><i></i><span>moetruyen / api studio</span></div><div class="terminal-content"><pre><span class="dim">// Một card, đủ để bắt đầu câu chuyện.</span>\n<span class="green">GET</span> /api/v1/comics/cards?page=1\n\n{ "title": "…", "thumbnail_url": "…",\n  "description": "…",\n  "translation_teams": [ ... ] }</pre></div><div class="terminal-foot"><span><span class="live-dot"></span> Dữ liệu từ truyen.moe</span><a href="#/api">Thử request ↗</a></div></div></section>`;}
function paginationHTML(page,totalPages,hasNext,path,query={}){return `<nav class="pagination" aria-label="Phân trang">${page>1?`<a class="button" href="${h(route(path,{...query,page:page-1}))}">← Trang trước</a>`:'<button class="button" disabled>← Trang trước</button>'}<span>Trang ${page} / ${Math.max(totalPages,1)}</span>${hasNext?`<a class="button" href="${h(route(path,{...query,page:page+1}))}">Trang sau →</a>`:'<button class="button" disabled>Trang sau →</button>'}</nav>`;}

async function renderLibrary(params,signal){
  const page=Math.max(1,Number(params.get("page"))||1),q=params.get("q")||"",genre=params.get("genre")||"",status=params.get("status")||"",sort=params.get("sort")||"updated_desc";
  const collection=collections[params.get("collection")]?params.get("collection"):"latest";
  $("#search-input").value=q;document.title="Khám phá · Mòe Studio";
  main.innerHTML=`<div class="container">${heroHTML()}<section id="library"><div class="library-top"><div><h2>${q?`Kết quả cho “${h(q)}”`:"Trên kệ hôm nay"}</h2><p id="library-meta">Đang lấy danh sách từ nguồn…</p></div><div class="library-tools"><select id="genre-filter" aria-label="Thể loại"><option value="">Tất cả thể loại</option></select><select id="status-filter" aria-label="Trạng thái"><option value="">Mọi trạng thái</option><option>Còn tiếp</option><option>Hoàn thành</option><option>Tạm dừng</option></select><select id="sort-filter" aria-label="Sắp xếp"><option value="updated_desc">Mới cập nhật</option><option value="title_asc">Tên A–Z</option><option value="views_desc">Nhiều lượt xem</option><option value="bookmarks_desc">Nhiều lượt lưu</option></select><button class="button small" id="refresh-library">${icon("refresh")}Tải lại</button></div></div><nav class="collection-tabs" aria-label="Nhóm truyện">${Object.entries(collections).map(([key,label])=>`<a class="${key===collection?"active":""}" href="${route("/browse",{collection:key})}">${h(label)}</a>`).join("")}</nav><div id="library-grid" class="card-grid" aria-live="polite">${skeletons()}</div><div id="library-pagination"></div></section></div>`;
  const constraints={...(q?{q}:{}),...(genre?{genre}:{}),...(status?{status}:{}),...(sort!=="updated_desc"?{sort}:{}),collection};
  $("#status-filter").value=status;$("#sort-filter").value=sort;
  for(const [id,name] of [["genre-filter","genre"],["status-filter","status"],["sort-filter","sort"]])$("#"+id).onchange=e=>{location.hash=route("/browse",{...constraints,[name]:e.target.value,page:1});};
  json("/api/v1/genres",{signal}).then(genres=>{if(signal.aborted)return;$("#genre-filter").innerHTML='<option value="">Tất cả thể loại</option>'+genres.map(g=>`<option value="${h(g.id)}" ${g.id===genre?"selected":""}>${h(g.name)}</option>`).join("");}).catch(()=>{});
  const filters={page,page_size:24,q,status,sort};if(genre)filters.include=genre;
  if(!status&&collection==="completed")filters.status="Hoàn thành";
  if(!status&&collection==="ongoing")filters.status="Còn tiếp";
  if(sort==="updated_desc"&&collection==="popular")filters.sort="views_desc";
  if(sort==="updated_desc"&&collection==="favorites")filters.sort="bookmarks_desc";
  async function load(refresh=false){
    $("#refresh-library").disabled=true;
    try{const data=await json("/api/v1/manga?"+new URLSearchParams({...filters,refresh}),{signal});if(signal.aborted)return;
      $("#library-grid").innerHTML=data.items.length?data.items.map((c,i)=>cardHTML(c,i)).join(""):'<div class="empty-state"><h2>Chưa tìm thấy truyện</h2><p>Thử tên hoặc bộ lọc khác.</p></div>';
      $("#library-meta").textContent=`${data.total.toLocaleString("vi-VN")} truyện khớp · ${data.count} truyện trên trang · Dữ liệu trực tiếp từ nguồn`;
      $("#library-pagination").innerHTML=paginationHTML(data.page,data.total_pages,data.has_next,"/browse",constraints);
    }catch(error){if(!signal.aborted){$("#library-grid").innerHTML=errorHTML(error);retry();}}
    finally{if(!signal.aborted)$("#refresh-library").disabled=false;}
  }
  $("#refresh-library").onclick=()=>load(true);await load();
}

async function renderCatalog(params,signal){
  main.innerHTML='<div class="initial-loading"><span class="spinner"></span> Đang lấy toàn bộ danh mục…</div>';
  if(!state.catalog)state.catalog=await json("/api/v1/comics/all",{signal});if(signal.aborted)return;
  const data=state.catalog,q=params.get("q")||"",page=Math.max(1,Number(params.get("page"))||1);
  const normalize=s=>s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replaceAll("đ","d").replaceAll("-"," ");
  const items=data.items.filter(item=>normalize(item.slug).includes(normalize(q))),totalPages=Math.max(1,Math.ceil(items.length/100)),current=Math.min(page,totalPages),shown=items.slice((current-1)*100,current*100);
  document.title="Toàn bộ danh mục · Mòe Studio";
  main.innerHTML=`<div class="container"><div class="library-top"><div><div class="eyebrow">TOÀN BỘ DANH MỤC</div><h1>${data.total.toLocaleString("vi-VN")} đầu truyện từ sitemap</h1><p>Danh mục đầy đủ gồm ID, slug và liên kết. Chọn truyện để xem ảnh, mô tả và chương.</p></div><button class="button" id="download-catalog">${icon("code")}Tải JSON đầy đủ</button></div><form id="catalog-search" class="catalog-search"><input name="q" aria-label="Tìm trong danh mục" placeholder="Tìm ID hoặc từ trong slug…" value="${h(q)}"><button class="button" type="submit">Tìm</button><a class="button" href="#/browse">Xem card</a></form><p class="description">${items.length.toLocaleString("vi-VN")} kết quả · Trang ${current}/${totalPages}</p><div class="catalog-table"><table><thead><tr><th>ID</th><th>Slug truyện</th><th>Chi tiết</th></tr></thead><tbody>${shown.map(item=>`<tr><td>${h(item.id)}</td><td><a href="${comicLink(item.slug)}">${h(item.slug)}</a></td><td><a class="button small" href="${comicLink(item.slug)}">Xem truyện →</a></td></tr>`).join("")}</tbody></table></div>${paginationHTML(current,totalPages,current<totalPages,"/catalog",q?{q}:{})}</div>`;
  $("#catalog-search").onsubmit=e=>{e.preventDefault();location.hash=route("/catalog",{q:new FormData(e.target).get("q")});};
  $("#download-catalog").onclick=()=>download(JSON.stringify(data,null,2),"moetruyen-catalog.json");
}
function download(content,name){const url=URL.createObjectURL(new Blob([content],{type:"application/json"}));state.blobs.push(url);const a=document.createElement("a");a.href=url;a.download=name;a.click();}
async function chaptersFor(id,comic,signal){if(state.chapters.has(id))return state.chapters.get(id);let items;if(comic?.chapter_pagination?.has_next || !comic)items=(await json(`/api/v1/comics/${encodeURIComponent(id)}/chapters/all`,{signal})).items;else items=comic.chapters || [];if(!signal.aborted)state.chapters.set(id,items);return items;}
const chapterLabel = chapter => [chapter.label || `Chương ${chapter.number}`,chapter.title].filter(Boolean).join(" · ");
async function renderComic(id,signal){
  main.innerHTML='<div class="initial-loading"><span class="spinner"></span> Đang mở truyện…</div>';
  const comic=await json(`/api/v1/comics/${encodeURIComponent(id)}`,{signal});if(signal.aborted)return;state.comic=comic;document.title=`${comic.title} · Mòe Studio`;
  const teams=(comic.translation_teams || []).map(t=>t.url?`<a href="${h(safeURL(t.url))}" target="_blank" rel="noopener">${h(t.name)} ↗</a>`:h(t.name)).join(", ");
  main.innerHTML=`<div class="container"><div class="breadcrumbs"><a href="#/browse">Khám phá</a><span>›</span><span>Chi tiết truyện</span></div><section class="detail-hero">${cover(comic,true)}<div><div class="eyebrow">${h(comic.status || "TRUYỆN TRANH")}${comic.adult?" · 18+":""}</div><h1>${h(comic.title)}</h1><p class="description">Tác giả: ${h((comic.authors || []).join(", ") || "Chưa có thông tin")}</p><div class="tags">${comic.genres.map(name=>`<a class="tag" href="${h(route("/browse",{genre:name}))}">${h(name)}</a>`).join("")}</div><p class="team-line"><strong>Nhóm dịch</strong> ${teams || "Nguồn chưa cung cấp"}</p><div class="detail-stats"><div>${fmt(comic.views)}<span>Lượt xem</span></div><div>${fmt(comic.followers)}<span>Lượt lưu</span></div><div>${fmt(comic.comments_count)}<span>Bình luận</span></div></div><div class="detail-actions" id="comic-read-actions"><span class="description">Đang lấy danh sách chương…</span></div></div><div class="detail-summary"><p class="description">${h(comic.description || "Nguồn chưa có mô tả.")}</p><a class="button small" href="${h(route("/api",{endpoint:"GET|/api/v1/comics/{comic_id}/basic",comic:fullId(comic)}))}">${icon("code")}API card của truyện</a></div></section><section class="section-panel"><div class="section-heading"><h2>Danh sách chương <small id="chapter-count"></small></h2><div class="tools"><input id="chapter-search" type="search" placeholder="Tìm chương…" aria-label="Tìm chương"><select id="chapter-order" aria-label="Thứ tự chương"><option value="desc">Mới nhất trước</option><option value="asc">Từ chương đầu</option></select></div></div><div id="chapter-list" class="chapter-grid"></div><button class="button load-more" id="more-chapters">Xem thêm chương</button><p class="description" id="chapter-notice"></p></section></div>`;
  let chapters=comic.chapters || [],limit=100;
  const render=()=>{const query=$("#chapter-search").value.trim().toLocaleLowerCase("vi"),ascending=$("#chapter-order").value==="asc";const ordered=ascending?[...chapters].reverse():chapters;const selected=ordered.filter(c=>chapterLabel(c).toLocaleLowerCase("vi").includes(query));$("#chapter-count").textContent=`(${chapters.length})`;$("#chapter-list").innerHTML=selected.slice(0,limit).map(c=>`<a class="chapter-row" href="${readLink(fullId(comic),c.number)}"><strong>${h(chapterLabel(c))}</strong><small>${h(c.team || c.updated_at || "Đọc chương")}</small></a>`).join("") || '<p class="description">Không có chương khớp.</p>';$("#more-chapters").hidden=selected.length<=limit;};
  $("#chapter-search").oninput=()=>{limit=100;render();};$("#chapter-order").onchange=()=>{limit=100;render();};$("#more-chapters").onclick=()=>{limit+=100;render();};render();
  const updateActions=()=>{const first=chapters.at(-1),latest=chapters[0],last=historyItems().find(item=>item.slug===fullId(comic));$("#comic-read-actions").innerHTML=first?`<a class="button primary" href="${readLink(fullId(comic),last?.number || first.number)}">${icon("book")}${last?"Đọc tiếp":"Đọc từ đầu"}</a><a class="button" href="${readLink(fullId(comic),latest.number)}">Chương mới nhất</a>`:'<p class="description">Chưa có chương.</p>';};
  try{chapters=await chaptersFor(fullId(comic),comic,signal);if(signal.aborted)return;render();updateActions();$("#chapter-notice").textContent="Đã lấy toàn bộ danh sách chương từ nguồn.";}
  catch(error){if(!signal.aborted){$("#chapter-notice").textContent=`Chưa tải được toàn bộ chương: ${error.message}`;$("#comic-read-actions").innerHTML=`<a class="button" href="${h(safeURL(comic.url))}" target="_blank" rel="noopener">Mở truyện tại nguồn ↗</a>`;}}
}
function refLink(value){try{const match=new URL(value,location.origin).pathname.match(/^\/manga\/([^/]+)\/chapters\/([^/]+)$/);return match?readLink(decodeURIComponent(match[1]),decodeURIComponent(match[2])):null;}catch{return null;}}
function readerImageHTML(image,index,number){
  const api=image.delivery==="browser_capture";
  return `<figure class="reader-page" data-index="${image.index}"><img ${api?`data-api-image="${h(image.url)}"`:`src="${h(safeURL(image.url))}"`} alt="Trang ${image.index+1} · Chương ${h(number)}" width="${image.width || 800}" height="${image.height || 1100}" loading="${api||index<2?"eager":"lazy"}" decoding="async" referrerpolicy="no-referrer" data-page-image data-fallback="${h(JSON.stringify((image.fallback_urls || []).map(safeURL).filter(Boolean)))}">${api?`<div class="page-loading">Đang tải trang ${image.index+1}…</div>`:""}</figure>`;
}
function loadReaderImages(signal){
  const pending=[],controllers=new Map();let active=0,observer=null,scheduled=false;
  const nearby=image=>{const box=image.getBoundingClientRect();return box.bottom>-1000&&box.top<innerHeight+2200;};
  const enqueue=(image,start=true)=>{if(signal.aborted || image.dataset.apiState)return;image.dataset.apiState="queued";pending.push(image);if(start)pump();};
  const visible=image=>{const box=image.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight;};
  const pump=()=>{pending.sort((a,b)=>Number(visible(b))-Number(visible(a)));while(active<2&&pending.length&&!signal.aborted){const image=pending.shift();active++;load(image).finally(()=>{active--;pump();});}};
  async function load(image){
    image.dataset.apiState="loading";
    const controller=new AbortController(),priority=visible(image)?"visible":"nearby";controllers.set(image,{controller,priority});
    try{
      const url=new URL(image.dataset.apiImage,location.origin);url.searchParams.set("priority",priority);
      const response=await fetch(url,{headers:{...state.headers,Accept:"image/jpeg,image/png"},signal:controller.signal});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.detail || `Không tải được ảnh (HTTP ${response.status}).`);}
      const blob=await response.blob();if(signal.aborted)return;
      if(!blob.type.startsWith("image/"))throw new Error("Máy chủ chưa trả ảnh hợp lệ.");
      const objectURL=URL.createObjectURL(blob);state.blobs.push(objectURL);image.loading="eager";image.src=objectURL;await image.decode();
      if(signal.aborted)return;image.dataset.apiState="loaded";image.parentElement.querySelector(".page-loading")?.remove();
    }catch(error){
      if(signal.aborted)return;
      if(controller.signal.aborted){delete image.dataset.apiState;if(nearby(image))enqueue(image);else observer?.observe(image);return;}
      image.hidden=true;image.dataset.apiState="error";image.parentElement.querySelector(".page-loading")?.remove();
      const box=document.createElement("div");box.className="image-error";const message=document.createElement("p");message.textContent=error.message;
      const button=document.createElement("button");button.type="button";button.className="button small";button.textContent="Tải lại trang";
      button.onclick=()=>{box.remove();image.hidden=false;delete image.dataset.apiState;enqueue(image);};box.append(message,button);image.parentElement.append(box);
    }finally{if(controllers.get(image)?.controller===controller)controllers.delete(image);}
  }
  const prioritize=()=>{
    scheduled=false;if(signal.aborted)return;
    for(let i=pending.length-1;i>=0;i--)if(!nearby(pending[i])){const image=pending.splice(i,1)[0];delete image.dataset.apiState;observer?.observe(image);}
    for(const [image,job] of controllers)if(!image.getAttribute("src")&&(!nearby(image)||(visible(image)&&job.priority==="nearby")))job.controller.abort();
    pump();
  };
  const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(prioritize);}};
  window.addEventListener("scroll",schedule,{passive:true,signal});window.addEventListener("resize",schedule,{passive:true,signal});
  signal.addEventListener("abort",()=>{pending.length=0;for(const job of controllers.values())job.controller.abort();},{once:true});
  const images=$$("#reader-images img[data-api-image]");
  if("IntersectionObserver" in window){observer=state.observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){enqueue(entry.target,false);observer.unobserve(entry.target);}pump();},{rootMargin:"2200px 0px"});images.forEach((image,index)=>{if(index<2)enqueue(image,false);else observer.observe(image);});pump();}
  else{images.forEach(image=>enqueue(image,false));pump();}
}
async function renderReader(id,number,signal){
  main.innerHTML='<div class="initial-loading"><span class="spinner"></span> Đang mở chương…</div>';
  const known=state.comic&&[state.comic.id,fullId(state.comic)].includes(id)?state.comic:null;
  const comicPromise=known?Promise.resolve(known):json(`/api/v1/comics/${encodeURIComponent(id)}`,{signal}).catch(()=>null);
  const chapter=await json(`/api/v1/comics/${encodeURIComponent(id)}/chapters/${encodeURIComponent(number)}?warm=true`,{signal});if(signal.aborted)return;
  const previous=refLink(chapter.previous_url),next=refLink(chapter.next_url);
  state.reader={id,number,previous,next};document.title=`${chapter.comic_title || known?.title || "Truyện"} · Chương ${number}`;
  const navigation=()=>`${previous?`<a class="button" data-reader-prev href="${previous}">← Trước</a>`:'<button class="button" disabled>← Trước</button>'}${next?`<a class="button primary" data-reader-next href="${next}">Tiếp →</a>`:'<button class="button" disabled>Tiếp →</button>'}`;
  const readable=chapter.images.filter(image=>image.url&&(!image.protected||image.delivery==="browser_capture"));
  main.innerHTML=`<div class="reader-toolbar"><a class="icon-button" href="${comicLink(id)}" aria-label="Về truyện">${icon("back")}</a><div class="reader-title"><strong id="reader-book-title">${h(chapter.comic_title || known?.title || "Truyện")}</strong><small>Chương ${h(number)}${chapter.title?` · ${h(chapter.title)}`:""}</small></div><select id="reader-chapter" aria-label="Chọn chương"><option value="${h(number)}">Chương ${h(number)}</option></select>${navigation()}<button class="icon-button" id="reader-width" aria-label="Đổi độ rộng">${icon("expand")}</button><button class="icon-button" id="reader-light" aria-label="Đổi nền đọc">${icon("sun")}</button></div><p class="reader-help">${chapter.total_pages} trang · Cuộn xuống để đọc · Phím ← → để chuyển chương.</p>${!readable.length?'<section class="protected-reader"><h1>Chưa tải được ảnh chương.</h1><p>Khởi động lại máy chủ để dùng trình đọc IMGX mới.</p></section>':""}<div id="reader-images" class="reader-content">${readable.map((image,index)=>readerImageHTML(image,index,number)).join("")}</div><section class="reader-end"><h2>Chương ${h(number)}${chapter.title?` · ${h(chapter.title)}`:""}</h2><div class="detail-actions">${navigation()}<a class="button" href="${comicLink(id)}">Về truyện</a></div></section>`;
  loadReaderImages(signal);
  $("#reader-width").onclick=()=>$("#reader-images").classList.toggle("wide");$("#reader-light").onclick=()=>{state.readerLight=!state.readerLight;document.body.dataset.readerLight=String(state.readerLight);};
  const comic=await comicPromise;if(signal.aborted)return;
  if(comic){state.comic=comic;saveHistory(comic,number,chapter.title);try{const chapters=await chaptersFor(fullId(comic),comic,signal);if(signal.aborted)return;$("#reader-chapter").innerHTML=chapters.map(c=>`<option value="${h(c.number)}" ${String(c.number)===number?"selected":""}>${h(chapterLabel(c))}</option>`).join("");}catch(error){if(!signal.aborted)toast("Chưa tải được bộ chọn chương: "+error.message);}}
  if(signal.aborted)return;$("#reader-chapter").onchange=e=>{location.hash=readLink(id,e.target.value);};
}
function renderHistory(){const items=historyItems();document.title="Đã đọc · Mòe Studio";main.innerHTML=`<div class="container"><div class="library-top"><div><div class="eyebrow">HÀNH TRÌNH CỦA BẠN</div><h1>Tiếp tục câu chuyện.</h1><p>Lịch sử chỉ lưu trên trình duyệt này.</p></div>${items.length?'<button class="button" id="clear-history">Xóa lịch sử</button>':""}</div><div class="card-grid">${items.length?items.map((c,i)=>cardHTML(c,i,true)).join(""):'<div class="empty-state"><h2>Chưa có truyện đã đọc</h2><a class="button primary" href="#/browse">Khám phá truyện</a></div>'}</div></div>`;$("#clear-history")?.addEventListener("click",()=>{try{localStorage.removeItem("moetruyen:history");}catch{}renderHistory();});}

function resolveSchema(schema,definition){if(!definition)return {};if(definition.$ref)return resolveSchema(schema,schema.components?.schemas?.[definition.$ref.split("/").pop()]);if(definition.anyOf)return {...resolveSchema(schema,definition.anyOf.find(d=>d.type!=="null")),...(definition.default!==undefined?{default:definition.default}:{})};return definition;}
function exampleValue(name,definition,params){if(definition.default!=null)return Array.isArray(definition.default)?definition.default.join(","):String(definition.default);return {comic_id:params.get("comic") || "2650-bartender-a-tokyo",number:"1",index:"0",q:"Bartender"}[name] || "";}
async function copyText(value){try{await navigator.clipboard.writeText(value);}catch{const textarea=document.createElement("textarea");textarea.value=value;document.body.append(textarea);textarea.select();document.execCommand("copy");textarea.remove();}toast("Đã sao chép cURL.");}
async function renderAPI(params,signal){
  const schema=await schemaPromise;if(signal.aborted)return;if(!schema)throw new Error("Chưa tải được OpenAPI, hãy tải lại trang.");
  const operations=[];for(const [path,methods] of Object.entries(schema.paths))for(const [method,operation] of Object.entries(methods))if(["get","post"].includes(method))operations.push({path,method:method.toUpperCase(),operation,key:method.toUpperCase()+"|"+path});
  const selected=operations.find(op=>op.key===params.get("endpoint")) || operations.find(op=>op.path==="/api/v1/comics/cards"),groups=new Map();for(const op of operations){const group=op.operation.tags?.[0] || "API";if(!groups.has(group))groups.set(group,[]);groups.get(group).push(op);}
  const parameters=selected.operation.parameters || [];document.title="Tài liệu API · Mòe Studio";
  main.innerHTML=`<div class="container"><div class="api-layout"><aside class="api-sidebar"><h2>API Reference</h2><small>${operations.length} endpoint · REST / JSON</small><input id="endpoint-search" type="search" aria-label="Tìm endpoint" placeholder="Tìm endpoint…"><div class="endpoint-groups">${[...groups].map(([group,items])=>`<div class="endpoint-group"><div class="api-group">${h(group)}</div>${items.map(op=>`<a class="endpoint-link ${op.key===selected.key?"active":""}" href="${h(route("/api",{endpoint:op.key,...(params.get("comic")?{comic:params.get("comic")}:{})}))}"><span class="method ${op.method==="POST"?"post":""}">${op.method}</span><span>${h(op.path.replace("/api/v1/","/"))}</span></a>`).join("")}</div>`).join("")}</div></aside><div class="api-content"><div class="api-intro"><div><div class="eyebrow">DÀNH CHO NGƯỜI XÂY DỰNG</div><h1>Thử API với dữ liệu thật.</h1><p>Chọn endpoint, nhập tham số và xem JSON mà thư viện truyện đang dùng.</p></div><span class="api-version">v${h(schema.info.version)}</span></div><div class="notice">Base URL: <strong>${h(location.origin)}</strong> · <a href="/swagger" target="_blank" rel="noopener">Swagger ↗</a></div><section class="api-panel"><div class="api-panel-heading"><div class="endpoint-path"><span class="method">${selected.method}</span>${h(selected.path)}</div><h2>${h(selected.operation.summary || "API")}</h2><p>${h(selected.operation.description || "")}</p></div><form id="api-try-form" class="api-form"><h3>Tham số</h3>${parameters.map((p,index)=>{const d=resolveSchema(schema,p.schema),value=exampleValue(p.name,d,params),choices=d.enum || (d.type==="boolean"?["true","false"]:null);return `<div class="parameter-row"><label class="parameter-label" for="param-${index}">${h(p.name)}${p.required?'<span class="required"> *</span>':""}<small>${h(p.in)}</small></label><div class="parameter-field">${choices?`<select id="param-${index}">${!p.required?'<option value="">Mặc định</option>':""}${choices.map(choice=>`<option value="${h(choice)}" ${String(choice)===value?"selected":""}>${h(choice)}</option>`).join("")}</select>`:`<input id="param-${index}" value="${h(value)}" type="${p.in==="header"?"password":d.type==="integer"?"number":"text"}" ${p.required?"required":""} placeholder="${d.type==="array"?"Cách nhau bằng dấu phẩy":"Giá trị tham số"}">`}${p.description?`<p>${h(p.description)}</p>`:""}</div></div>`;}).join("")}${selected.method==="POST"?'<label for="api-body"><h3>JSON body</h3></label><textarea id="api-body" spellcheck="false">'+h(JSON.stringify({filters:{page:1,perPage:24,q:"Bartender"},refresh:false},null,2))+"</textarea>":""}<div class="try-actions"><button class="button primary" id="execute-request" type="submit">${icon("code")}Gửi request</button><button class="button" type="button" id="copy-curl">${icon("copy")}Sao chép cURL</button></div></form></section><section class="api-panel"><div class="response-toolbar"><strong>cURL</strong></div><pre id="curl-command" class="code-block"></pre></section><section class="api-panel" id="api-response"><div class="response-toolbar"><strong>Response</strong></div><pre class="code-block">Gửi request để xem dữ liệu.</pre></section></div></div></div>`;
  $("#endpoint-search").oninput=e=>{$$(".endpoint-group").forEach(group=>{let visible=0;$$(".endpoint-link",group).forEach(link=>{link.hidden=!link.textContent.toLowerCase().includes(e.target.value.toLowerCase());if(!link.hidden)visible++;});group.hidden=!visible;});};
  const buildRequest=()=>{let path=selected.path;const query=new URLSearchParams(),headers={...state.headers};parameters.forEach((p,i)=>{const value=$("#param-"+i).value.trim(),d=resolveSchema(schema,p.schema);if(p.in==="path")path=path.replace("{"+p.name+"}",encodeURIComponent(value));else if(p.in==="query"&&value!==""){if(d.type==="array")value.split(",").map(x=>x.trim()).filter(Boolean).forEach(x=>query.append(p.name,x));else query.set(p.name,value);}else if(p.in==="header"&&value!=="")headers[p.name]=value;});const url=location.origin+path+(query.size?"?"+query:""),body=selected.method==="POST"?$("#api-body").value:null;if(body)headers["Content-Type"]="application/json";const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";return {url,body,headers,curl:`curl -X ${selected.method} ${quote(url)}`+Object.entries(headers).map(([k,v])=>` \\\n  -H ${quote(k+": "+v)}`).join("")+(body?` \\\n  -d ${quote(body)}`:"")};};
  const updateCurl=()=>{$("#curl-command").textContent=buildRequest().curl;};$$("input,select,textarea",$("#api-try-form")).forEach(input=>input.addEventListener("input",updateCurl));updateCurl();$("#copy-curl").onclick=()=>copyText(buildRequest().curl);
  $("#api-try-form").onsubmit=async e=>{
    e.preventDefault();const request=buildRequest();if(request.body){try{JSON.parse(request.body);}catch{toast("JSON body chưa hợp lệ.");return;}}
    const button=$("#execute-request"),start=performance.now();button.disabled=true;
    try{
      const response=await fetch(request.url,{method:selected.method,signal,headers:request.headers,body:request.body || undefined});
      const blob=await response.blob();if(signal.aborted)return;
      const isImage=blob.type.startsWith("image/"),url=URL.createObjectURL(blob);state.blobs.push(url);
      $("#api-response").innerHTML=`<div class="response-toolbar"><strong class="${response.ok?"ok":"failed"}">HTTP ${response.status}</strong><span>${Math.round(performance.now()-start)} ms</span><a id="download-response" class="button small" href="${url}" download="response.${isImage?(blob.type.includes("jpeg")?"jpg":"png"):"json"}">Tải ${isImage?"ảnh":"JSON"} ↓</a></div>`;
      if(isImage){const image=document.createElement("img");image.className="response-image";image.src=url;image.alt="Trang truyện trả về từ API";$("#api-response").append(image);}
      else{let formatted=await blob.text();try{formatted=JSON.stringify(JSON.parse(formatted),null,2);}catch{}const pre=document.createElement("pre");pre.className="code-block";pre.textContent=formatted.length>50000?formatted.slice(0,50000)+"\n… Tải JSON để xem đầy đủ.":formatted;$("#api-response").append(pre);}
    }catch(error){if(!signal.aborted){$("#api-response").innerHTML='<pre class="code-block"></pre>';$("#api-response pre").textContent=error.message;}}
    finally{if(!signal.aborted)button.disabled=false;}
  };
}

async function renderRoute(){
  window.MoeCovers.reset();
  state.controller?.abort();state.observer?.disconnect();state.reader=null;state.blobs.forEach(URL.revokeObjectURL);state.blobs=[];
  const controller=new AbortController();state.controller=controller;const signal=controller.signal;
  let url,parts;try{url=new URL(location.hash.slice(1) || "/browse",location.origin);parts=url.pathname.split("/").filter(Boolean).map(decodeURIComponent);}catch{location.hash="/browse";return;}
  const view=parts[0] || "browse";document.body.dataset.view=view==="read"?"reader":view;document.body.dataset.readerLight=String(state.readerLight);
  $$("[data-nav]").forEach(a=>{const selected=a.dataset.nav===(["api","catalog","history"].includes(view)?view:"browse");if(selected)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");});main.setAttribute("aria-busy","true");window.scrollTo({top:0,behavior:"instant"});
  try{if(view==="comic"&&parts[1])await renderComic(parts[1],signal);else if(view==="read"&&parts[1]&&parts[2])await renderReader(parts[1],parts[2],signal);else if(view==="catalog")await renderCatalog(url.searchParams,signal);else if(view==="api")await renderAPI(url.searchParams,signal);else if(view==="history")renderHistory();else await renderLibrary(url.searchParams,signal);}
  catch(error){if(!signal.aborted){main.innerHTML='<div class="container">'+errorHTML(error)+"</div>";retry();}}finally{if(!signal.aborted)main.setAttribute("aria-busy","false");}
}
$("#global-search").onsubmit=e=>{e.preventDefault();location.hash=route("/browse",{q:$("#search-input").value.trim()});};
$("#connection-settings").onclick=()=>{$("#connection-key").value=state.headers["X-API-Key"] || "";$("#connection-cookie").value=state.headers["X-Source-Cookie"] || "";$("#connection-dialog").showModal();};
$("#connection-close").onclick=()=>$("#connection-dialog").close();
$("#connection-form").onsubmit=e=>{e.preventDefault();const key=$("#connection-key").value.trim(),cookie=$("#connection-cookie").value.trim();state.headers={...(key?{"X-API-Key":key}:{}),...(cookie?{"X-Source-Cookie":cookie}:{})};state.catalog=null;state.chapters.clear();state.comic=null;$("#connection-dialog").close();renderRoute();};
try{document.body.dataset.theme=localStorage.getItem("moetruyen:theme") || "light";}catch{}
$("#theme-toggle").onclick=()=>{const theme=document.body.dataset.theme==="dark"?"light":"dark";document.body.dataset.theme=theme;try{localStorage.setItem("moetruyen:theme",theme);}catch{}};
document.addEventListener("keydown",e=>{if(!state.reader || ["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)||e.ctrlKey||e.altKey||e.metaKey)return;if(e.key==="ArrowRight"&&state.reader.next){e.preventDefault();location.hash=state.reader.next;}if(e.key==="ArrowLeft"&&state.reader.previous){e.preventDefault();location.hash=state.reader.previous;}});
window.addEventListener("hashchange",renderRoute);renderRoute();
