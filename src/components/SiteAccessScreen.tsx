import { ArrowRight, BookOpen, Loader2, LogIn, LogOut, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { Link } from "react-router-dom";

type Props = {
  loading: boolean;
  failed: boolean;
  fetching: boolean;
  loggedIn: boolean;
  admin: boolean;
  message?: string;
  onRetry: () => void;
  onLogout: () => void;
};

export default function SiteAccessScreen({ loading, failed, fetching, loggedIn, admin, message, onRetry, onLogout }: Props) {
  const actionClass = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background";
  return (
    <main className="flex min-h-svh flex-col bg-background px-6 text-foreground sm:px-10">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between border-b border-border py-7">
        <span className="ed-heading text-3xl tracking-tight">Manga<span className="text-primary">Hub</span><span className="text-primary">.</span></span>
        <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:inline-flex"><BookOpen className="h-4 w-4" aria-hidden="true" />Không gian của những câu chuyện</span>
      </header>

      <section aria-labelledby="site-access-title" className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-8 py-12 md:grid-cols-[1.1fr_1fr] md:gap-14 md:py-20">
        <div className="order-2 max-w-xl md:order-1">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
            {loading ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" /> : failed ? <WifiOff className="h-3.5 w-3.5" aria-hidden="true" /> : <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
            {loading ? "Đang kết nối" : failed ? "Kết nối gián đoạn" : "Truy cập riêng tư"}
          </div>
          <div aria-live="polite" aria-atomic="true">
            <h1 id="site-access-title" className="ed-heading text-4xl leading-[1.15] sm:text-5xl lg:text-6xl">
              {loading ? "Đang kiểm tra quyền truy cập…" : failed ? "Chưa thể kiểm tra quyền truy cập" : "Bạn chưa được cấp quyền truy cập."}
            </h1>
            <p className="mt-6 max-w-md text-sm leading-7 text-muted-foreground sm:text-base">
              {loading ? "Chờ một chút nhé. MangaHub đang xác nhận quyền truy cập của bạn." : failed ? "Kết nối chưa hoàn tất. Bạn có thể kiểm tra lại hoặc đăng nhập lại để tiếp tục." : message || "Website hiện chỉ dành cho tài khoản được cấp quyền. Vui lòng liên hệ admin để được thêm vào danh sách truy cập."}
            </p>
          </div>
          {loading ? (
            <div role="status" className="mt-8 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" />Đang xác nhận tài khoản</div>
          ) : (
            <div className="mt-8 flex flex-wrap gap-3">
              {failed && admin ? (
                <Link to="/admin" className={`${actionClass} bg-primary text-primary-foreground hover:bg-primary/90`}>Vào trang quản trị<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
              ) : !loggedIn ? (
                <Link to="/login" className={`${actionClass} bg-primary text-primary-foreground hover:bg-primary/90`}><LogIn className="h-4 w-4" aria-hidden="true" />Đăng nhập</Link>
              ) : null}
              <button type="button" disabled={fetching} onClick={onRetry} className={`${actionClass} border border-border bg-card hover:bg-secondary disabled:cursor-wait disabled:opacity-50`}>
                <RefreshCw className={`h-4 w-4 ${fetching ? "motion-safe:animate-spin" : ""}`} aria-hidden="true" />{fetching ? "Đang kiểm tra…" : "Kiểm tra lại"}
              </button>
            </div>
          )}
          {!loading && loggedIn && <button type="button" onClick={onLogout} className="mt-6 inline-flex items-center gap-2 rounded text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-primary"><LogOut className="h-3.5 w-3.5" aria-hidden="true" />Đổi tài khoản</button>}
        </div>

        <div aria-hidden="true" className="relative order-1 mx-auto w-full max-w-[260px] md:order-2 md:max-w-[430px]">
          <div className="absolute inset-[5%] rounded-full bg-secondary/70" />
          <svg viewBox="0 0 430 390" fill="none" className="relative w-full">
            <ellipse cx="215" cy="340" rx="143" ry="13" className="fill-foreground/5" />
            <path d="M86 105L207 129V321L86 296V105Z" className="fill-card stroke-foreground" strokeWidth="2" />
            <path d="M207 129L339 100V292L207 321V129Z" className="fill-card stroke-foreground" strokeWidth="2" />
            <path d="M80 114L67 119V307L207 337L354 302V114L343 109" className="stroke-foreground" strokeWidth="2" strokeLinejoin="round" />
            <path d="M207 321V337M96 305L195 326M222 325L333 299" className="stroke-foreground/30" strokeWidth="2" />
            <path d="M104 128L185 144V211L104 195V128Z" className="fill-secondary" />
            <path d="M105 226L185 242M105 241L168 254M105 256L178 271" className="stroke-foreground/25" strokeWidth="3" strokeLinecap="round" />
            <path d="M233 157L318 138M233 173L308 156M233 189L318 170M233 247L318 228M233 263L292 250" className="stroke-foreground/25" strokeWidth="3" strokeLinecap="round" />
            <path d="M269 116V204L286 190L303 196V108L269 116Z" className="fill-primary" />
            <path d="M119 174L136 154L151 177L165 167L184 195" className="stroke-foreground/30" strokeWidth="2" strokeLinejoin="round" />
            <circle cx="343" cy="78" r="37" className="fill-primary" />
            {loading ? <g fill="white" className="motion-safe:animate-pulse"><circle cx="331" cy="78" r="2.5" /><circle cx="343" cy="78" r="2.5" /><circle cx="355" cy="78" r="2.5" /></g> : <g stroke="white" strokeWidth="2.5" strokeLinecap="round"><rect x="332" y="76" width="22" height="17" rx="3" /><path d="M336 76V70A7 7 0 0 1 350 70V76M343 83V86" /></g>}
            <path d="M75 66V88M64 77H86M357 237V251M350 244H364" className="stroke-primary" strokeWidth="2" strokeLinecap="round" />
            <circle cx="145" cy="70" r="4" className="fill-primary/40" />
            <circle cx="373" cy="163" r="3" className="fill-foreground/25" />
          </svg>
        </div>
      </section>
      <footer className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 border-t border-border py-6 text-[11px] text-muted-foreground"><span>MangaHub · Thế giới truyện của bạn</span><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />Bảo vệ quyền truy cập</span></footer>
    </main>
  );
}
