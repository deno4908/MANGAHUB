// Standalone Worker: paste this entire file into Cloudflare's code editor.
// Attach to the frontend's routes; keep the existing source Worker separate.
const blockedPage = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#18181b">
  <title>Khu vực chưa được hỗ trợ — MangaHub</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; min-height: 100svh;
      background: #18181b; color: #f2f2f2;
      font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .page { width: min(1120px, 100%); min-height: 100svh; margin: auto; padding: 0 40px; display: flex; flex-direction: column; }
    .topbar { min-height: 100px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #343438; }
    .brand { display: inline-flex; align-items: center; gap: 11px; font-size: 21px; font-weight: 850; letter-spacing: -1px; }
    .brand svg { width: 28px; height: 28px; color: #ef4444; }
    .brand span span { color: #ef4444; }
    .region { display: inline-flex; align-items: center; gap: 8px; padding: 7px 11px; border: 1px solid #3d3033; border-radius: 6px; color: #d9b3b5; font-size: 11px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; }
    .region::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #ef4444; }
    main { flex: 1; display: grid; grid-template-columns: 1.15fr 1fr; align-items: center; gap: 44px; padding: 70px 0 80px; }
    .eyebrow { margin: 0 0 24px; display: flex; align-items: center; gap: 12px; color: #a9a9b0; font-size: 11px; font-weight: 650; letter-spacing: .16em; text-transform: uppercase; }
    .eyebrow::before { content: ""; width: 30px; height: 3px; border-radius: 2px; background: #dc2626; }
    h1 { margin: 0; font-family: "Noto Serif", Georgia, "Times New Roman", serif; font-size: clamp(44px, 5vw, 66px); font-weight: 400; line-height: 1.15; letter-spacing: -.045em; }
    h1 em { color: #ef4444; font-style: normal; }
    .description { max-width: 390px; margin: 25px 0 0; color: #b1b1ba; font-size: 15px; line-height: 1.85; }
    .help { max-width: 395px; display: flex; gap: 12px; align-items: flex-start; margin: 28px 0 24px; padding: 16px; background: #212124; border: 1px solid #343438; border-radius: 8px; }
    .help svg { flex: 0 0 18px; margin-top: 3px; color: #b5b5bf; }
    .help p { margin: 0; color: #aaaab4; font-size: 13px; line-height: 1.75; }
    .help strong { color: #e5e5e9; font-weight: 600; }
    .retry { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 46px; padding: 0 21px; color: white; background: #dc2626; border: 1px solid #ed4545; border-radius: 7px; text-decoration: none; font-size: 13px; font-weight: 700; transition: background .15s; }
    .retry:hover { background: #b91c1c; }
    .retry:focus-visible { outline: 3px solid #fca5a5; outline-offset: 4px; }
    .art { margin: 0; position: relative; min-width: 0; }
    .art > svg { display: block; width: 100%; height: auto; }
    .art figcaption { margin-top: 2px; text-align: center; color: #aaaab4; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; }
    footer { min-height: 65px; display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 18px 0; border-top: 1px solid #343438; color: #aaaab4; font-size: 11px; line-height: 1.6; }
    footer span:last-child { color: #aaaab4; }
    @media (min-width: 1400px) { main { padding-top: 100px; padding-bottom: 110px; } }
    @media (max-width: 700px) {
      .page { padding: 0 24px; }
      .topbar { min-height: 76px; }
      .brand { font-size: 19px; }
      .brand svg { width: 24px; height: 24px; }
      .region { font-size: 9px; padding: 6px 8px; }
      main { grid-template-columns: 1fr; gap: 26px; padding: 36px 0 42px; }
      .art { grid-row: 1; width: min(285px, 85%); margin: 0 auto; }
      .art figcaption { display: none; }
      .copy { text-align: center; }
      .eyebrow { justify-content: center; margin-bottom: 17px; font-size: 10px; }
      h1 { font-size: clamp(39px, 10vw, 52px); }
      .description { margin: 19px auto 0; font-size: 14px; }
      .help { margin: 23px auto 21px; text-align: left; }
      .retry { width: min(395px, 100%); }
      footer { align-items: flex-start; font-size: 10px; }
      footer span:last-child { text-align: right; }
    }
    @media (max-width: 360px) { .page { padding: 0 18px; } .region { letter-spacing: 0; } }
    @media (prefers-reduced-motion: reduce) { .retry { transition: none; } }
  </style>
</head>
<body>
  <div class="page">
    <header class="topbar">
      <div class="brand" aria-label="MangaHub">
        <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M14 6v18M14 6C10 3 6 3 2 4v17c4-1 8-1 12 2 4-3 8-3 12-2V4c-4-1-8-1-12 2Z"/>
          <path d="m6 8 5 1m-5 4 5 1m7-5 4-1m-4 6 4-1"/>
        </svg>
        <span>MANGA<span>HUB</span></span>
      </div>
      <span class="region">Dành cho Việt Nam</span>
    </header>

    <main aria-labelledby="page-title">
      <section class="copy">
        <p class="eyebrow">Khu vực chưa được hỗ trợ</p>
        <h1 id="page-title">Hẹn bạn tại<br><em>Việt Nam.</em></h1>
        <p class="description">MangaHub hiện chỉ hỗ trợ truy cập từ IP Việt Nam.
          Cảm ơn bạn đã ghé thăm và quan tâm đến những câu chuyện tại đây.</p>
        <div class="help">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>
          </svg>
          <p><strong>Bạn đang ở Việt Nam?</strong><br>
            Hãy tắt VPN hoặc proxy, sau đó tải lại trang để tiếp tục đọc truyện.</p>
        </div>
        <a class="retry" href="" rel="nofollow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M20 7v5h-5M4 17v-5h5"/>
            <path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17"/>
          </svg>
          Tải lại trang
        </a>
      </section>

      <figure class="art">
        <svg viewBox="0 0 460 440" fill="none" role="img" aria-labelledby="art-title">
          <title id="art-title">Cuốn manga với dấu trang đỏ và biểu tượng khóa</title>
          <defs>
            <pattern id="dots" width="9" height="9" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1" fill="#71717a" opacity=".34"/>
            </pattern>
            <pattern id="ink" width="5" height="5" patternUnits="userSpaceOnUse">
              <path d="M0 5 5 0" stroke="#27272a" stroke-width=".6" opacity=".4"/>
            </pattern>
          </defs>
          <circle cx="235" cy="225" r="168" fill="url(#dots)"/>
          <path d="m36 101 31 9m-12-31 8 18m325 223 31 9m-24 7 8 18M371 77l-9 17m29-6-18 12" stroke="#52525b" stroke-width="2"/>
          <ellipse cx="237" cy="372" rx="150" ry="13" fill="#101012"/>
          <g transform="rotate(-9 230 220)">
            <path d="M78 97h284v250H78z" fill="#242427" stroke="#52525b" stroke-width="2"/>
            <path d="M85 90h284v250H85z" fill="#aaa79e" stroke="#18181b" stroke-width="2"/>
            <path d="M91 83h284v250H91z" fill="#e8e4da" stroke="#18181b" stroke-width="3"/>
            <path d="M102 74c51-9 88-4 127 12 40-16 83-21 135-12v244c-52-9-95-4-135 12-39-16-76-21-127-12V74Z" fill="#f1ede3" stroke="#18181b" stroke-width="3" stroke-linejoin="round"/>
            <path d="M229 86v244" stroke="#a7a29a" stroke-width="2"/>
            <path d="m114 88 102 5v111l-102-11V88Z" fill="#29292d" stroke="#18181b" stroke-width="2"/>
            <path d="m114 88 102 5v111l-102-11V88Z" fill="url(#ink)"/>
            <circle cx="181" cy="122" r="15" fill="#f1ede3"/>
            <path d="m116 175 24-27 17 21 22-20 35 43-98-11Z" fill="#71717a"/>
            <path d="m126 109 15 7m-16 12 9 2m66 35 10 7" stroke="#f1ede3" opacity=".65" stroke-width="2"/>
            <path d="m114 209 45 5v83l-45-5v-83Zm55 6 47 5v83l-47-5v-83Z" fill="#d5d0c5" stroke="#18181b" stroke-width="2"/>
            <path d="m116 286 41-56m-41 40 41-40m15 60 42-58m-42 40 42-40" stroke="#aaa49a" stroke-width="3"/>
            <path d="m244 94 105-7v69l-105 8V94Z" fill="#d5d0c5" stroke="#18181b" stroke-width="2"/>
            <path d="m254 109 75-5m-75 14 61-4m-61 14 69-5m-69 15 43-3" stroke="#99938a" stroke-width="3"/>
            <path d="m244 177 105-8v129l-105 10V177Z" fill="#29292d" stroke="#18181b" stroke-width="2"/>
            <path d="m249 182 94-7v117l-94 9V182Z" fill="url(#dots)"/>
            <path d="m266 301 36-98 36 91" stroke="#71717a" stroke-width="2"/>
            <path d="m296 67 27-3v58l-14-8-13 10V67Z" fill="#dc2626" stroke="#18181b" stroke-width="2"/>
          </g>
          <g transform="rotate(7 331 286)">
            <rect x="278" y="235" width="109" height="102" rx="8" fill="#101012"/>
            <rect x="271" y="228" width="109" height="102" rx="8" fill="#dc2626" stroke="#18181b" stroke-width="3"/>
            <path d="M314 268v-9a12 12 0 0 1 24 0v9" stroke="#fff5ec" stroke-width="3"/>
            <rect x="307" y="267" width="38" height="30" rx="4" stroke="#fff5ec" stroke-width="3"/>
            <circle cx="326" cy="280" r="3" fill="#fff5ec"/>
            <path d="M326 282v5" stroke="#fff5ec" stroke-width="2"/>
            <path d="M294 312h64" stroke="#f87171" stroke-width="2"/>
          </g>
          <path d="m96 340-10 18m17-11-8 17m285-206 15-8m-10 19 17-7" stroke="#ef4444" stroke-width="2"/>
        </svg>
        <figcaption>Một khoảng dừng trước trang tiếp theo</figcaption>
      </figure>
    </main>

    <footer>
      <span>© MangaHub</span>
      <span>Truyện hay, chờ bạn khám phá.</span>
    </footer>
  </div>
</body>
</html>`;

export function denyOutsideVietnam(request) {
  if (request.cf?.country === "VN") return null;
  const wantsHtml = (request.headers.get("accept") || "").toLowerCase().includes("text/html");
  return new Response(request.method === "HEAD" ? null : wantsHtml ? blockedPage : JSON.stringify({
    code: "COUNTRY_NOT_SUPPORTED", detail: "Hi?n ch? h? tr? truy c?p t? Vi?t Nam.",
  }), { status: 403, headers: {
    "Content-Type": wantsHtml ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  }});
}
