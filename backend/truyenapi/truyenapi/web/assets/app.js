"use strict";

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const h = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const paths = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3V4zm9 3a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20"/>',
  moon: '<path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="m12 3 10 18H2L12 3zM12 9v5m0 3v1"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
$$('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
const main = $("#main");
const collections = {latest:"Mới cập nhật", new:"Truyện mới", popular:"Nhiều lượt xem", completed:"Hoàn thành", favorites:"Yêu thích", exclusive:"Độc quyền"};
const fallbackId = "botsuraku-youtei-nanode-kajishokunin-wo-mezasu-3230";
const state = {controller:null, observer:null, comic:null, reader:null, genres:null, blobs:[], readerLight:false, toastTimer:null};
state.libraryRefresh = null;
state.libraryRefreshedAt = 0;
const POLL_MS = 60_000;
const numberFormat = new Intl.NumberFormat("vi-VN", {notation:"compact", maximumFractionDigits:1});
const fmt = value => value == null ? "—" : numberFormat.format(Number(String(value).replace(/[^0-9.]/g, "")) || 0);
const fullId = card => card.slug && card.id ? `${card.slug}-${card.id}` : card.full_identifier;
const route = (path, query = {}) => "#" + path + (Object.keys(query).length ? "?" + new URLSearchParams(query) : "");
const comicLink = id => route("/comic/" + encodeURIComponent(id));
const readLink = (id, number) => route("/read/" + encodeURIComponent(id) + "/" + encodeURIComponent(number));
const chapterRank = chapter => {
  const match = (chapter.title || "").match(/(?:Chương|Chapter|Chap)\s*(\d+(?:\.\d+)?)/i) || String(chapter.number).match(/^(\d+(?:[.-]\d+)?)/);
  return match ? Number(match[1].replace("-", ".")) : -1;
};
const sortedChapters = (chapters, asc = false) => [...chapters].sort((a,b) => (chapterRank(a)-chapterRank(b)) * (asc ? 1 : -1));

function safeURL(value) {
  try { const url = new URL(value, location.origin); return ["http:","https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}
function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("visible");
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.classList.remove("visible"), 2400);
}
async function json(path, options = {}) {
  const response = await fetch(path, {...options, headers:{Accept:"application/json", ...(options.body ? {"Content-Type":"application/json"} : {}), ...options.headers}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    let message = data.detail || `Yêu cầu thất bại (HTTP ${response.status})`;
    if (Array.isArray(message)) message = message.map(item => item.msg || String(item)).join("; ");
    throw new Error(message);
  }
  return data;
}
const schemaPromise = json("/openapi.json").then(schema => {
  $("#api-status").textContent = `API v${schema.info.version} · Trực tuyến`; return schema;
}).catch(error => { $("#api-status").textContent = "Chưa kết nối được API"; return null; });

function historyItems() {
  try {
    const items = JSON.parse(localStorage.getItem("truyenapi:history") || "[]");
    return Array.isArray(items) ? items.filter(item => item && typeof item.id === "string" && typeof item.title === "string" && item.number != null).slice(0,30) : [];
  } catch { return []; }
}
function saveHistory(comic, number, title) {
  try {
    const entry = {id:String(comic.id), slug:comic.slug, title:comic.title, thumbnail_url:comic.thumbnail_url || comic.cover_urls?.[0], number:String(number), chapter_title:title, full_identifier:fullId(comic), saved_at:Date.now()};
    localStorage.setItem("truyenapi:history", JSON.stringify([entry, ...historyItems().filter(item => item.id !== entry.id)].slice(0,30)));
  } catch { /* Storage may be disabled; reading remains available. */ }
}
function cover(card, eager = false, overlay = "") {
  const candidates = [...new Set([card.thumbnail_url, ...(card.thumbnail_fallback_urls || []), ...(card.cover_urls || [])].filter(Boolean))].map(safeURL).filter(Boolean);
  if (fullId(card)) candidates.push(location.origin + `/api/v1/comics/${encodeURIComponent(fullId(card))}/cover`);
  const source = candidates.shift();
  return `<div class="cover"><div class="cover-placeholder">${icon("book")}</div>${source ? `<img src="${h(source)}" alt="Bìa ${h(card.title)}" width="300" height="400" loading="${eager ? "eager" : "lazy"}" decoding="async" referrerpolicy="no-referrer" data-fallback="${h(JSON.stringify(candidates))}">` : ""}${overlay}</div>`;
}
document.addEventListener("error", event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || image.dataset.fallback === undefined) return;
  let urls = []; try { urls = JSON.parse(image.dataset.fallback); } catch { /* Use placeholder. */ }
  if (urls.length) { const next = urls.shift(); image.dataset.fallback = JSON.stringify(urls); image.src = next; }
  else image.remove();
}, true);
function cardHTML(card, index = 10, history = false) {
  const id = fullId(card); if (!id) return "";
  const target = history ? readLink(id, card.number) : comicLink(id);
  const chapter = history ? card.chapter_title || `Chương ${card.number}` : card.latest_chapter?.title || "Xem chi tiết";
  const badge = card.labels?.[0];
  const overlay = `${badge ? `<span class="cover-label">${h(badge)}</span>` : ""}<span class="cover-read"><span>${card.views == null ? "Đọc truyện" : `${fmt(card.views)} lượt xem`}</span>${icon("arrow")}</span>`;
  return `<article class="manga-card"><a href="${h(target)}" aria-label="${h(history ? "Đọc tiếp " : "Mở truyện ")}${h(card.title)}"><div class="cover-wrap">${cover(card,index<6,overlay)}</div><h3 class="card-title">${h(card.title)}</h3><div class="card-meta"><span class="chapter-label">${h(chapter)}</span><span class="updated-label">${h(card.updated_at || (history ? "Đọc tiếp" : ""))}</span></div></a></article>`;
}
function skeletons() {
  return Array.from({length:12}, () => '<div><div class="skeleton skeleton-cover"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join("");
}
function errorHTML(error, title = "Chưa tải được dữ liệu") {
  return `<div class="empty-state"><div class="error-icon">${icon("alert")}</div><h2>${h(title)}</h2><p>${h(error.message || error)}</p><button class="button primary" data-retry>${icon("refresh")}Thử lại</button></div>`;
}
function wireRetry(parent = main) { $("[data-retry]",parent)?.addEventListener("click", () => renderRoute()); }
function heroHTML() {
  const last = historyItems()[0];
  return `<section class="hero"><div><div class="eyebrow"><span class="live-dot"></span> TRUYỆN & API, TRONG CÙNG MỘT TRANG</div><h1>Chương truyện mới.<br><span>Một lần chạm là đọc.</span></h1><p>Khám phá những câu chuyện bạn yêu thích. Đọc ngay tại đây, hoặc dùng API để xây thế giới truyện của riêng bạn.</p><div class="hero-actions"><a class="button primary" href="#library">${icon("book")}Khám phá truyện</a><a class="subtle" href="#/api">Thử API ${icon("arrow")}</a></div></div><div class="terminal" aria-label="Ví dụ API lấy manga card"><div class="terminal-bar"><i></i><i></i><i></i><span>truyenapi / playground</span></div><div class="terminal-content"><pre><span class="dim">// Một request. Cả một kệ truyện.</span>\n<span class="green">GET</span> /api/v1/comics/cards?page=1\n\n{\n  <span class="green">"items"</span>: [ ...mangaCards ],\n  <span class="green">"page"</span>: 1,\n  <span class="green">"has_next"</span>: true\n}</pre></div><div class="terminal-foot"><span><span class="live-dot"></span> Dữ liệu trực tiếp từ nguồn</span><a href="#/api">Mở tài liệu ↗</a></div></div></section>${last ? `<div class="resume">${icon("clock")}<span>Gần đây:</span><strong>${h(last.title)}</strong><a href="${h(readLink(last.full_identifier || fullId(last),last.number))}">Đọc tiếp ${h(last.chapter_title || "chương " + last.number)} →</a></div>` : ""}`;
}
async function loadGenres(signal) {
  if (!state.genres) state.genres = await json("/api/v1/genres",{signal});
  return state.genres;
}
async function renderLibrary(params, signal, refresh = false) {
  const collection = collections[params.get("collection")] ? params.get("collection") : "latest";
  const page = Math.max(1,parseInt(params.get("page") || "1",10) || 1);
  const genre = params.get("genre") || "";
  const q = (params.get("q") || "").trim();
  const minutes = params.get("within_minutes") || "";
  const day = params.get("date") || "";
  const timeFiltered = Boolean(minutes || day);
  $("#search-input").value = q;
  document.title = `${q ? "Tìm " + q : collections[collection]} · TruyenAPI Studio`;
  main.innerHTML = `<div class="container">${heroHTML()}<section id="library"><div class="library-top"><div><h2>${q ? `Kết quả cho “${h(q)}”` : "Tủ truyện của hôm nay"}</h2><p id="library-meta">Đang lấy truyện từ nguồn…</p></div><div class="library-tools"><label class="sr-only" for="genre-filter">Thể loại</label><select id="genre-filter"><option value="">Tất cả thể loại</option></select><button class="button small" id="refresh-library" title="Tải lại danh sách">${icon("refresh")}Tải lại</button></div></div><nav class="collection-tabs" aria-label="Nhóm truyện">${Object.entries(collections).map(([key,title]) => `<a class="${collection===key&&!q&&!genre?"active":""}" href="${route("/browse",{collection:key})}">${h(title)}</a>`).join("")}</nav><div id="library-grid" class="card-grid" aria-live="polite">${skeletons()}</div><div id="library-pagination"></div></section></div>`;
  const tools = $(".library-tools");
  tools.insertAdjacentHTML("afterbegin", `<label class="sr-only" for="update-filter">Thời gian cập nhật</label><select id="update-filter"><option value="">Mọi thời gian</option><option value="5">5 phút gần đây</option><option value="15">15 phút gần đây</option><option value="60">1 giờ gần đây</option><option value="1440">24 giờ gần đây</option><option value="date">Chọn ngày…</option></select><input id="update-date" type="date" aria-label="Ngày cập nhật (giờ Việt Nam)" ${day?"":"hidden"} value="${h(day)}">`);
  $("#update-filter").value = day ? "date" : minutes;
  $("#update-filter").onchange = event => {
    if (event.target.value === "date") { $("#update-date").hidden=false;$("#update-date").focus();return; }
    location.hash = route("/browse",{collection:"latest",...(event.target.value?{within_minutes:event.target.value}:{})});
  };
  $("#update-date").onchange = event => { if(event.target.value)location.hash=route("/browse",{collection:"latest",date:event.target.value}); };
  $("#genre-filter").onchange = event => { location.hash = route("/browse",{genre:event.target.value}); };
  loadGenres(signal).then(genres => {
    if (signal.aborted) return;
    $("#genre-filter").innerHTML = '<option value="">Tất cả thể loại</option>' + genres.map(g => `<option value="${h(g.id)}" ${[g.id,g.slug].includes(genre)?"selected":""}>${h(g.name)}</option>`).join("");
  }).catch(() => { /* Lists still work if the genre menu is unavailable. */ });
  let path;
  if (timeFiltered) path = "/api/v1/updates?" + new URLSearchParams({page,...(day?{date:day}:{within_minutes:minutes})});
  else if (q) path = "/api/v1/search?" + new URLSearchParams({q});
  else if (genre) path = `/api/v1/genres/${encodeURIComponent(genre)}/comics?page=${page}`;
  else path = "/api/v1/comics/cards?" + new URLSearchParams({collection,page,refresh});
  let loading = false, loaded = false;
  const reload = async (force = false) => {
    if (loading || signal.aborted) return;
    loading = true;
    const button = $("#refresh-library");button.disabled=true;
    try {
    const requestPath = force && !q && !genre ? path.replace(/([?&])refresh=[^&]*/g,"$1refresh=true") + (path.includes("refresh=") ? "" : "&refresh=true") : path;
    const data = await json(requestPath,{signal}); if (signal.aborted) return;
    loaded = true;
    $("#library-grid").innerHTML = data.items.length ? data.items.map((card,index) => cardHTML(card,index)).join("") : `<div class="empty-state"><h2>Chưa tìm thấy truyện</h2><p>${timeFiltered?"Trang nguồn này không có truyện khớp thời gian đã chọn. Bạn có thể xem trang sau hoặc mở rộng khoảng thời gian.":"Thử tên khác hoặc chọn một thể loại khác nhé."}</p><a class="button" href="#/browse">Về danh sách mới cập nhật</a></div>`;
    const updated = data.fetched_at ? new Intl.DateTimeFormat("vi-VN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Ho_Chi_Minh"}).format(new Date(data.fetched_at)) : null;
    const constraints = {...(genre?{genre}:{}),...(day?{date:day}:minutes?{within_minutes:minutes}:{})};
    $("#library-meta").textContent = `${data.items.length} truyện${q ? " · Kết quả tìm kiếm nhanh" : ` · Trang ${page}${data.total_pages ? " / " + data.total_pages : ""}`}${updated ? " · Lấy từ nguồn lúc " + updated : ""} · Tự làm mới mỗi phút${timeFiltered?" · Lọc theo khoảng thời gian nguồn cung cấp (có thể ước tính)":""}`;
    if (!q) $("#library-pagination").innerHTML = `<nav class="pagination" aria-label="Phân trang">${page>1 ? `<a class="button" href="${route("/browse",{collection,page:page-1,...constraints})}">${icon("back")}Trang trước</a>` : `<button class="button" disabled>${icon("back")}Trang trước</button>`}<span>Trang ${page}${data.total_pages ? " / " + data.total_pages : ""}</span>${data.has_next ? `<a class="button" href="${route("/browse",{collection,page:page+1,...constraints})}">Trang sau${icon("arrow")}</a>` : '<button class="button" disabled>Trang sau →</button>'}</nav>`;
    } catch (error) { if (!signal.aborted) { if (!loaded) { $("#library-grid").innerHTML=errorHTML(error);wireRetry(); } $("#library-meta").textContent=loaded?"Chưa làm mới được từ nguồn; đang giữ danh sách trước đó. Sẽ thử lại sau một phút.":"Nguồn đang phản hồi chậm hoặc chưa khả dụng."; } }
    finally { loading=false;if(!signal.aborted){button.disabled=false;state.libraryRefreshedAt=Date.now();} }
  };
  state.libraryRefresh = () => reload();
  $("#refresh-library").onclick = () => reload(true);
  await reload(refresh);
}
function renderHistory() {
  const items = historyItems(); document.title = "Truyện đã đọc · TruyenAPI Studio";
  main.innerHTML = `<div class="container"><div class="library-top"><div><div class="eyebrow">KỆ TRUYỆN CÁ NHÂN</div><h1 style="font-size:28px;margin:10px 0 0">Tiếp tục câu chuyện.</h1><p>Lịch sử chỉ lưu trên trình duyệt của bạn.</p></div>${items.length?'<button id="clear-history" class="button">Xóa lịch sử</button>':""}</div><div class="card-grid">${items.length?items.map((item,index)=>cardHTML(item,index,true)).join(""):'<div class="empty-state"><div class="error-icon">'+icon("book")+'</div><h2>Chưa có truyện đã đọc</h2><p>Mở một chương truyện, lần sau bạn có thể tiếp tục ngay tại đây.</p><a class="button primary" href="#/browse">Khám phá truyện</a></div>'}</div></div>`;
  $("#clear-history")?.addEventListener("click",()=>{ try{localStorage.removeItem("truyenapi:history");}catch{} renderHistory();toast("Đã xóa lịch sử trên trình duyệt này."); });
}
async function renderComic(id, signal) {
  main.innerHTML = '<div class="container"><div class="initial-loading"><span class="spinner"></span> Đang mở thông tin truyện…</div></div>';
  const comic = await json(`/api/v1/comics/${encodeURIComponent(id)}`,{signal}); if (signal.aborted) return;
  state.comic = {...comic, full_identifier:id}; document.title = `${comic.title} · TruyenAPI Studio`;
  const chapters = sortedChapters(comic.chapters || []), first = chapters.at(-1), latest = chapters[0];
  const key = fullId(comic), last = historyItems().find(item=>item.id===comic.id);
  main.innerHTML = `<div class="container"><div class="breadcrumbs"><a href="#/browse">Khám phá</a><span>›</span><span>Chi tiết truyện</span></div><section class="detail-hero">${cover(comic,true)}<div><div class="eyebrow">${h(comic.status || "TRUYỆN TRANH")}</div><h1>${h(comic.title)}</h1>${comic.alternative_names?`<p class="detail-alt">${h(comic.alternative_names)}</p>`:""}<div class="tags">${comic.genres.map(g=>`<a class="tag" href="${route("/browse",{genre:g.url.split("/").pop()})}">${h(g.name)}</a>`).join("")}</div><div class="detail-stats"><div>${chapters.length}<span>Chương truyện</span></div><div>${fmt(comic.metadata?.["Lượt xem"])}<span>Lượt xem</span></div><div>${fmt(comic.metadata?.["Lượt theo dõi"])}<span>Theo dõi</span></div></div><div class="detail-actions">${first?`<a class="button primary" href="${readLink(key,last?.number || first.number)}">${icon("book")}${last?"Đọc tiếp":"Đọc từ đầu"}</a>`:""}${latest?`<a class="button" href="${readLink(key,latest.number)}">${h(latest.title)}</a>`:""}<a class="button" href="${route("/api",{endpoint:"GET|/api/v1/comics/{comic_id}",comic:key})}">${icon("code")}Xem API</a></div></div><div class="detail-summary"><p id="comic-description" class="description clamp">${h(comic.description || "Nguồn chưa có mô tả cho truyện này.")}</p>${comic.description?.length>240?'<button class="button text small" id="toggle-description">Xem thêm mô tả</button>':""}</div></section><section class="section-panel"><div class="section-heading"><h2>Danh sách chương <span style="color:var(--muted);font-size:12px">(${chapters.length})</span></h2><div class="tools"><input id="chapter-search" type="search" placeholder="Tìm chương…" aria-label="Tìm chương"><select id="chapter-order" aria-label="Sắp xếp chương"><option value="desc">Mới nhất trước</option><option value="asc">Từ chương đầu</option></select></div></div><div id="chapter-list" class="chapter-grid"></div><button id="more-chapters" class="button load-more">Xem thêm chương</button></section>${comic.comments?.length?`<section class="section-panel"><div class="section-heading"><h2>Bình luận từ nguồn</h2></div>${comic.comments.slice(0,10).map(c=>`<article class="comment"><strong>${h(c.author || "Bạn đọc")}</strong><small>${h(c.time)}</small><p>${h(c.content)}</p></article>`).join("")}</section>`:""}</div>`;
  $("#toggle-description")?.addEventListener("click",event=>{ const clamped=$("#comic-description").classList.toggle("clamp");event.target.textContent=clamped?"Xem thêm mô tả":"Thu gọn"; });
  let limit = 100;
  const renderChapters = () => {
    const query=$("#chapter-search").value.trim().toLocaleLowerCase("vi"), asc=$("#chapter-order").value==="asc";
    const selected=sortedChapters(chapters,asc).filter(c=>!query||`${c.title} ${c.number}`.toLocaleLowerCase("vi").includes(query));
    $("#chapter-list").innerHTML=selected.slice(0,limit).map(ch=>`<a class="chapter-row" href="${readLink(key,ch.number)}"><strong>${h(ch.title)}</strong><small>${h(ch.updated_at || "Đọc chương")}</small></a>`).join("") || '<p class="description">Không có chương khớp với tìm kiếm.</p>';
    $("#more-chapters").hidden=selected.length<=limit;
  };
  $("#chapter-search").oninput=()=>{limit=100;renderChapters();};$("#chapter-order").onchange=()=>{limit=100;renderChapters();};$("#more-chapters").onclick=()=>{limit+=100;renderChapters();};renderChapters();
}
function refLink(url) {
  if (!url) return null;
  try { const match=new URL(url,location.origin).pathname.match(/\/truyen-tranh\/(.+)-chap-([^/]+)$/);return match?readLink(match[1],match[2]):null; }catch{return null;}
}
async function renderReader(id, number, signal) {
  main.innerHTML='<div class="initial-loading"><span class="spinner"></span> Đang mở chương truyện…</div>';
  const known=state.comic && (fullId(state.comic)===id || state.comic.id===id) ? state.comic : null;
  const comicPromise=known?Promise.resolve(known):json(`/api/v1/comics/${encodeURIComponent(id)}`,{signal}).catch(()=>null);
  const chapter=await json(`/api/v1/comics/${encodeURIComponent(id)}/chapters/${encodeURIComponent(number)}`,{signal});if(signal.aborted)return;
  const previous=refLink(chapter.previous_url), next=refLink(chapter.next_url);
  const navigation=()=>`${previous?`<a class="button" data-reader-prev href="${previous}">${icon("back")}Trước</a>`:'<button class="button" disabled>← Trước</button>'}${next?`<a class="button primary" data-reader-next href="${next}">Tiếp${icon("arrow")}</a>`:'<button class="button" disabled>Tiếp →</button>'}`;
  state.reader={id,number,chapter,previous,next};
  document.title=`Chương ${number} · TruyenAPI Studio`;
  main.innerHTML=`<div class="reader-toolbar"><a class="icon-button" href="${comicLink(id)}" title="Về trang truyện" aria-label="Về trang truyện">${icon("back")}</a><div class="reader-title"><strong id="reader-book-title">${h(known?.title || chapter.title)}</strong><small>${chapter.images.length} trang ảnh · Cuộn xuống để đọc</small></div><select id="reader-chapter" aria-label="Chọn chương"><option value="${h(number)}">Chương ${h(number)}</option></select>${navigation()}<button class="icon-button" id="reader-width" title="Đổi độ rộng" aria-label="Đổi độ rộng trang đọc">${icon("expand")}</button><button class="icon-button" id="reader-light" title="Đổi nền đọc" aria-label="Đổi nền đọc">${icon("sun")}</button></div><p class="reader-help">Dùng phím ← → để chuyển chương. Ảnh được tải khi bạn cuộn gần đến.</p><div id="reader-images" class="reader-content">${chapter.images.map((image,index)=>`<figure class="reader-page" data-index="${image.index}"><img alt="Trang ${image.index} — Chương ${h(number)}" width="800" height="1100" decoding="async" ${index<2?'fetchpriority="high"':''} data-reader-source="/api/v1/comics/${encodeURIComponent(id)}/chapters/${encodeURIComponent(number)}/images/${image.index}"${index<2?` src="/api/v1/comics/${encodeURIComponent(id)}/chapters/${encodeURIComponent(number)}/images/${image.index}"`:""}></figure>`).join("")}</div><section class="reader-end"><h2>Bạn đã đến cuối chương ${h(number)}.</h2><p>${next?"Câu chuyện vẫn đang tiếp tục.":"Bạn đã đọc tới chương cuối hiện có từ nguồn."}</p><div class="detail-actions">${navigation()}<a class="button" href="${comicLink(id)}">Danh sách chương</a></div></section>`;
  const loadImage=image=>{if(!image.getAttribute("src"))image.src=image.dataset.readerSource;};
  if("IntersectionObserver" in window){state.observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){loadImage(entry.target);state.observer.unobserve(entry.target);}},{rootMargin:"1200px 0px"});$$("#reader-images img").forEach(image=>{if(!image.src)state.observer.observe(image);});}else $$("#reader-images img").forEach(loadImage);
  $$("#reader-images img").forEach(image=>image.addEventListener("error",()=>{
    image.hidden=true;let box=$(".image-error",image.parentElement);
    if(!box){box=document.createElement("div");box.className="image-error";box.innerHTML=`${icon("alert")}<div>Ảnh chưa tải được từ máy chủ nguồn.</div><button class="button small">${icon("refresh")}Thử tải lại</button>`;image.parentElement.append(box);$("button",box).onclick=()=>{box.remove();image.hidden=false;image.src=image.dataset.readerSource+"?attempt="+Date.now();};}
  }));
  $("#reader-width").onclick=()=>$("#reader-images").classList.toggle("wide");
  $("#reader-light").onclick=()=>{state.readerLight=!state.readerLight;document.body.dataset.readerLight=String(state.readerLight);};
  const comic=await comicPromise;if(signal.aborted)return;
  if(comic){state.comic=comic;$("#reader-book-title").textContent=comic.title;document.title=`${comic.title} · Chương ${number}`;const chapters=sortedChapters(comic.chapters || [],true);$("#reader-chapter").innerHTML=chapters.map(ch=>`<option value="${h(ch.number)}" ${ch.number===number?"selected":""}>${h(ch.title)}</option>`).join("");saveHistory(comic,number,chapters.find(ch=>ch.number===number)?.title || `Chương ${number}`);}
  $("#reader-chapter").onchange=event=>{location.hash=readLink(id,event.target.value);};
}

function resolveSchema(schema, definition) {
  if(!definition)return{};
  if(definition.$ref)return resolveSchema(schema,schema.components?.schemas?.[definition.$ref.split("/").pop()]);
  if(definition.anyOf){const value=definition.anyOf.find(x=>x.type!=="null");return {...resolveSchema(schema,value),...(definition.default!==undefined?{default:definition.default}:{})};}
  return definition;
}
function exampleValue(name, definition, params) {
  const examples={comic_id:params.get("comic") || (state.comic?fullId(state.comic):fallbackId),number:"1",index:"1",genre_id:"action",author_slug:"dang-cap-nhat-239",comment_id:"11144842",q:"one piece"};
  if(definition.default!==undefined&&definition.default!==null)return Array.isArray(definition.default)?definition.default.join(","):String(definition.default);
  return examples[name] || "";
}
async function copyText(value) {
  try{await navigator.clipboard.writeText(value);}catch{const node=document.createElement("textarea");node.value=value;document.body.append(node);node.select();document.execCommand("copy");node.remove();}toast("Đã sao chép lệnh cURL.");
}
async function renderAPI(params, signal) {
  main.innerHTML='<div class="initial-loading"><span class="spinner"></span> Đang mở tài liệu API…</div>';
  const schema=await schemaPromise;if(signal.aborted)return;if(!schema)throw new Error("Chưa tải được OpenAPI. Kiểm tra API và tải lại trang.");
  const operations=[];
  for(const [path,methods] of Object.entries(schema.paths))for(const [method,operation] of Object.entries(methods))if(["get","post"].includes(method))operations.push({path,method:method.toUpperCase(),operation,key:method.toUpperCase()+"|"+path});
  const key=params.get("endpoint") || "GET|/api/v1/comics/cards";
  const selected=operations.find(x=>x.key===key) || operations[0];
  const groups=Map.groupBy?Map.groupBy(operations,x=>x.operation.tags?.[0] || "API"):operations.reduce((map,item)=>{const group=item.operation.tags?.[0] || "API";if(!map.has(group))map.set(group,[]);map.get(group).push(item);return map;},new Map());
  document.title="Tài liệu & thử API · TruyenAPI Studio";
  const parameters=selected.operation.parameters || [];
  main.innerHTML=`<div class="container"><div class="api-layout"><aside class="api-sidebar"><h2>API Reference</h2><small class="description">${operations.length} endpoint · REST / JSON</small><input id="endpoint-search" type="search" placeholder="Tìm endpoint…" aria-label="Tìm endpoint"><div class="endpoint-groups">${[...groups].map(([group,items])=>`<div class="endpoint-group"><div class="api-group">${h(group)}</div>${items.map(item=>`<a class="endpoint-link ${item.key===selected.key?"active":""}" href="${route("/api",{endpoint:item.key,...(params.get("comic")?{comic:params.get("comic")}:{})})}" title="${h(item.operation.summary)}"><span class="method ${item.method==="POST"?"post":""}">${item.method}</span><span>${h(item.path.replace("/api/v1/","/"))}</span></a>`).join("")}</div>`).join("")}</div></aside><div class="api-content"><div class="api-intro"><div><div class="eyebrow">DÀNH CHO NGƯỜI XÂY DỰNG</div><h1>Tài liệu, có thể chạm vào.</h1><p>Chọn endpoint, đổi tham số và xem dữ liệu thực tế. Tất cả dùng cùng API với thư viện truyện bên cạnh.</p></div><span class="api-version">v${h(schema.info.version)}</span></div><div class="notice">Base URL: <strong>${h(location.origin)}</strong> <span>·</span> <a href="/swagger" target="_blank" rel="noopener">Mở Swagger ↗</a></div><section class="api-panel"><div class="api-panel-heading"><div class="endpoint-path"><span class="method ${selected.method==="POST"?"post":""}">${selected.method}</span>${h(selected.path)}</div><h2>${h(selected.operation.summary || "API")}</h2>${selected.operation.description?`<p>${h(selected.operation.description)}</p>`:""}</div><form id="api-try-form" class="api-form"><h3>Tham số</h3>${parameters.length?parameters.map((parameter,index)=>{
    const definition=resolveSchema(schema,parameter.schema),value=exampleValue(parameter.name,definition,params),id="param-"+index;
    const choices=definition.enum || (definition.type==="boolean"?["true","false"]:null);
    const field=choices?`<select id="${id}" ${parameter.required?"required":""}>${!parameter.required?'<option value="">Mặc định</option>':""}${choices.map(choice=>`<option value="${h(choice)}" ${String(choice)===value?"selected":""}>${h(choice)}</option>`).join("")}</select>`:`<input id="${id}" value="${h(value)}" ${parameter.required?"required":""} placeholder="${definition.type==="array"?"Giá trị cách nhau bằng dấu phẩy":"Giá trị tham số"}" ${definition.type==="integer"?'type="number"':'type="text"'}>`;
    return `<div class="parameter-row"><label class="parameter-label" for="${id}">${h(parameter.name)}${parameter.required?'<span class="required"> *</span>':""}<small>${h(parameter.in)} · ${h(definition.type || "string")}</small></label><div class="parameter-field">${field}${parameter.description?`<p>${h(parameter.description)}</p>`:""}</div></div>`;
  }).join(""):'<p class="description">Endpoint này không cần tham số.</p>'}${selected.method==="POST"?`<label for="api-body"><h3>JSON body</h3></label><textarea id="api-body" spellcheck="false">${h(JSON.stringify({ids:[params.get("comic") || fallbackId]},null,2))}</textarea>`:""}<div class="try-actions"><button id="execute-request" class="button primary" type="submit">${icon("code")}Gửi request</button><button class="button" type="button" id="copy-curl">${icon("copy")}Sao chép cURL</button><small>Request chạy trên API hiện tại của bạn.</small></div></form></section><section class="api-panel"><div class="response-toolbar"><strong>cURL</strong></div><pre id="curl-command" class="code-block"></pre></section><section class="api-panel" id="api-response"><div class="response-toolbar"><strong>Response</strong><span class="description">Chưa gửi request</span></div><pre class="code-block">Nhấn “Gửi request” để xem dữ liệu thực tế.</pre></section></div></div></div>`;
  $("#endpoint-search").oninput=event=>{const query=event.target.value.toLowerCase();$$(".endpoint-group").forEach(group=>{let visible=0;$$(".endpoint-link",group).forEach(a=>{a.hidden=!a.textContent.toLowerCase().includes(query);if(!a.hidden)visible++;});group.hidden=!visible;});};
  const buildRequest=()=>{
    let path=selected.path;const query=new URLSearchParams();
    parameters.forEach((parameter,index)=>{const value=$("#param-"+index).value.trim(),definition=resolveSchema(schema,parameter.schema);if(parameter.in==="path")path=path.replace("{"+parameter.name+"}",encodeURIComponent(value));else if(parameter.in==="query"&&value!==""){if(definition.type==="array")value.split(",").map(x=>x.trim()).filter(Boolean).forEach(x=>query.append(parameter.name,x));else query.set(parameter.name,value);}});
    const url=location.origin+path+(query.size?"?"+query:"");const body=selected.method==="POST"?$("#api-body").value:null;
    const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
    return{url,body,curl:`curl -X ${selected.method} ${quote(url)}`+(body?` \\\n  -H 'Content-Type: application/json' \\\n  -d ${quote(body)}`:"")};
  };
  const updateCurl=()=>{$("#curl-command").textContent=buildRequest().curl;};
  $$("input,select,textarea",$("#api-try-form")).forEach(input=>input.addEventListener("input",updateCurl));updateCurl();
  $("#copy-curl").onclick=()=>copyText(buildRequest().curl);
  $("#api-try-form").onsubmit=async event=>{
    event.preventDefault();const request=buildRequest();
    if(request.body){try{JSON.parse(request.body);}catch{toast("JSON body chưa hợp lệ.");return;}}
    const button=$("#execute-request");button.disabled=true;button.textContent="Đang gửi…";const started=performance.now();
    try{
      const response=await fetch(request.url,{method:selected.method,signal,headers:request.body?{"Content-Type":"application/json"}:{},body:request.body || undefined});
      const contentType=response.headers.get("content-type") || "",blob=await response.blob();if(signal.aborted)return;
      const elapsed=Math.round(performance.now()-started),size=(blob.size/1024).toFixed(1),objectURL=URL.createObjectURL(blob);state.blobs.push(objectURL);
      $("#api-response").innerHTML=`<div class="response-toolbar"><strong class="${response.ok?"ok":"failed"}">HTTP ${response.status}</strong><span>${elapsed} ms</span><span>${size} KB</span><a href="${objectURL}" download="response.${contentType.includes("json")?"json":contentType.startsWith("image/")?"image":"txt"}">Tải kết quả ↓</a></div>`;
      if(contentType.startsWith("image/")){const image=document.createElement("img");image.className="response-image";image.src=objectURL;image.alt="Ảnh trả về từ API";$("#api-response").append(image);}
      else {let value=await blob.text();try{value=JSON.stringify(JSON.parse(value),null,2);}catch{}const pre=document.createElement("pre");pre.className="code-block";pre.textContent=value.length>30000?value.slice(0,30000)+"\n\n… Đã rút gọn hiển thị. Tải kết quả để xem đầy đủ.":value;$("#api-response").append(pre);}
    }catch(error){if(!signal.aborted){$("#api-response").innerHTML='<div class="response-toolbar"><strong class="failed">Request chưa thành công</strong></div>';const pre=document.createElement("pre");pre.className="code-block";pre.textContent=error.message;$("#api-response").append(pre);}}
    finally{if(!signal.aborted){button.disabled=false;button.innerHTML=icon("code")+"Gửi request";}}
  };
}
async function renderRoute() {
  state.libraryRefresh = null;
  state.controller?.abort();state.observer?.disconnect();state.reader=null;state.blobs.forEach(URL.revokeObjectURL);state.blobs=[];
  const controller=new AbortController();state.controller=controller;const signal=controller.signal;
  let url;try{url=new URL(location.hash.slice(1) || "/browse",location.origin);}catch{location.hash="/browse";return;}
  const parts=url.pathname.split("/").filter(Boolean).map(decodeURIComponent),view=parts[0] || "browse";
  document.body.dataset.view=view==="read"?"reader":view;document.body.dataset.readerLight=String(state.readerLight);
  $$("[data-nav]").forEach(a=>{const active=a.dataset.nav===(view==="api"?"api":view==="history"?"history":"browse");if(active)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");});
  main.setAttribute("aria-busy","true");window.scrollTo({top:0,behavior:"instant"});
  try {
    if(view==="api")await renderAPI(url.searchParams,signal);
    else if(view==="comic"&&parts[1])await renderComic(parts[1],signal);
    else if(view==="read"&&parts[1]&&parts[2])await renderReader(parts[1],parts[2],signal);
    else if(view==="history")renderHistory();
    else await renderLibrary(url.searchParams,signal);
  } catch(error) {if(!signal.aborted){main.innerHTML='<div class="container">'+errorHTML(error)+"</div>";wireRetry();}}
  finally{if(!signal.aborted)main.setAttribute("aria-busy","false");}
}
$("#global-search").onsubmit=event=>{event.preventDefault();const q=$("#search-input").value.trim();location.hash=route("/browse",q?{q}:{});};
document.addEventListener("click",event=>{const link=event.target.closest('a[href="#library"],a[href="#main"]');if(link){event.preventDefault();const target=$(link.getAttribute("href"));target?.scrollIntoView({behavior:"smooth",block:"start"});if(link.getAttribute("href")==="#main")main.focus({preventScroll:true});}});
try{document.body.dataset.theme=localStorage.getItem("truyenapi:theme") || "light";}catch{}
$("#theme-toggle").onclick=()=>{const next=document.body.dataset.theme==="dark"?"light":"dark";document.body.dataset.theme=next;try{localStorage.setItem("truyenapi:theme",next);}catch{};};
document.addEventListener("keydown",event=>{if(!state.reader || ["INPUT","SELECT","TEXTAREA"].includes(document.activeElement?.tagName) || event.altKey || event.ctrlKey || event.metaKey)return;if(event.key==="ArrowRight"&&state.reader.next){event.preventDefault();location.hash=state.reader.next;}if(event.key==="ArrowLeft"&&state.reader.previous){event.preventDefault();location.hash=state.reader.previous;}});
window.addEventListener("hashchange",()=>{if(location.hash==="#library"){document.getElementById("library")?.scrollIntoView({behavior:"smooth",block:"start"});return;}renderRoute();});
function pollLibrary() {
  if (!document.hidden && state.libraryRefresh && Date.now()-state.libraryRefreshedAt >= POLL_MS) state.libraryRefresh();
}
setInterval(pollLibrary, POLL_MS);
document.addEventListener("visibilitychange",pollLibrary);
renderRoute();
