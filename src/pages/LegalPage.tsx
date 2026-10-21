import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, FileText, Mail, ShieldCheck } from "lucide-react";
import BrandLogo from "@/components/manga/BrandLogo";
import LegalLinks from "@/components/LegalLinks";
import { SUPPORT_EMAIL, supportMailto } from "@/lib/support";

type Section = { id: string; title: string; content: ReactNode };
const outsideLink = "font-medium text-primary underline underline-offset-4 hover:text-foreground";
const contact = <a href={supportMailto()} className={outsideLink}>{SUPPORT_EMAIL}</a>;

const privacySections: Section[] = [
  { id: "thong-tin", title: "Thông tin được xử lý", content: <>
    <p>Khi bạn sử dụng các tính năng tương ứng, MangaHub xử lý thông tin tài khoản như email, tên người dùng, tên hiển thị, ảnh đại diện và thông tin đăng nhập do bạn hoặc nhà cung cấp đăng nhập cung cấp.</p>
    <p>Dữ liệu sử dụng có thể gồm truyện theo dõi, lịch sử và tiến độ đọc, đánh giá, bình luận, nội dung tải lên, thiết lập cá nhân và thông tin bạn gửi trong yêu cầu hỗ trợ. Máy chủ và dịch vụ hạ tầng cũng có thể ghi nhận địa chỉ IP, thông tin trình duyệt, thời điểm truy cập và lỗi để vận hành, bảo vệ hệ thống.</p>
  </> },
  { id: "muc-dich", title: "Mục đích sử dụng", content: <>
    <p>Thông tin được dùng để tạo và xác thực tài khoản, duy trì phiên đăng nhập, lưu trải nghiệm đọc, gửi thông báo theo cài đặt, xử lý yêu cầu hỗ trợ và quản lý nội dung cộng đồng.</p>
    <p>MangaHub sử dụng dữ liệu kỹ thuật và hoạt động cần thiết để phát hiện spam, giới hạn yêu cầu bất thường, kiểm tra quyền truy cập, xử lý vi phạm và khắc phục sự cố.</p>
  </> },
  { id: "cookie", title: "Cookie và dữ liệu trên thiết bị", content: <>
    <p>Website sử dụng cookie để duy trì và bảo vệ phiên đăng nhập, hỗ trợ đăng nhập qua dịch vụ khác và xác nhận quyền tải nội dung. Trình duyệt cũng lưu một số thiết lập, dấu hiệu phiên và trạng thái truy cập để website hoạt động nhất quán giữa các lần mở.</p>
    <p>Bạn có thể quản lý hoặc xóa cookie và dữ liệu website trong trình duyệt. Việc này có thể làm bạn đăng xuất hoặc mất thiết lập trên thiết bị; nó không tự xóa dữ liệu đã lưu trong tài khoản trên máy chủ.</p>
  </> },
  { id: "hien-thi", title: "Thông tin công khai và quyền riêng tư", content: <>
    <p>Tên hiển thị, ảnh đại diện, hồ sơ, bình luận, đánh giá và nội dung bạn đăng có thể hiển thị cho người khác tùy tính năng và quyền truy cập. Trong phần Cài đặt → Quyền riêng tư, bạn có thể điều chỉnh các lựa chọn hiện có về hồ sơ, lịch sử đọc và truyện theo dõi.</p>
    <p>Quản trị viên được phân quyền có thể xử lý thông tin tài khoản, yêu cầu hỗ trợ và hoạt động liên quan để vận hành, kiểm duyệt hoặc giải quyết khiếu nại. Không đăng mật khẩu, mã xác minh, token phiên hoặc thông tin riêng tư của người khác vào nội dung công khai.</p>
  </> },
  { id: "dich-vu", title: "Dịch vụ bên ngoài", content: <>
    <p>MangaHub sử dụng các dịch vụ hạ tầng và lưu trữ như Vercel, Supabase, Cloudflare và Redis để phục vụ website. Đăng nhập qua Google hoặc Discord chỉ trao đổi thông tin cần cho luồng đăng nhập tương ứng. Khi ảnh hoặc nội dung được tải từ nguồn bên ngoài, trình duyệt có thể kết nối trực tiếp đến nguồn đó.</p>
    <p>Khi được bật, Google reCAPTCHA giúp bảo vệ các biểu mẫu khỏi lạm dụng. Việc sử dụng dịch vụ Google chịu sự điều chỉnh của <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className={outsideLink}>Chính sách quyền riêng tư</a> và <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer" className={outsideLink}>Điều khoản dịch vụ của Google</a>. Các nhà cung cấp bên ngoài có chính sách xử lý dữ liệu riêng.</p>
  </> },
  { id: "luu-tru", title: "Lưu trữ và bảo vệ dữ liệu", content: <>
    <p>Dữ liệu tài khoản và hoạt động được lưu để cung cấp những tính năng bạn sử dụng, hỗ trợ tài khoản và bảo vệ hệ thống. Một số nhật ký, dữ liệu sao lưu hoặc thông tin liên quan đến việc xử lý vi phạm có thể vẫn được lưu khi cần giải quyết sự cố hoặc yêu cầu liên quan.</p>
    <p>MangaHub áp dụng xác thực và phân quyền để hạn chế truy cập dữ liệu. Không có hệ thống nào bảo đảm an toàn tuyệt đối; hãy sử dụng mật khẩu riêng, giữ kín thông tin đăng nhập và liên hệ hỗ trợ nếu nghi ngờ tài khoản bị truy cập trái phép.</p>
  </> },
  { id: "yeu-cau", title: "Lựa chọn và yêu cầu của bạn", content: <>
    <p>Bạn có thể chỉnh sửa thông tin và thiết lập được cung cấp trong tài khoản, quản lý lịch sử đọc và nội dung của mình qua các chức năng hiện có. Để yêu cầu kiểm tra, chỉnh sửa hoặc xóa dữ liệu ngoài các chức năng này, hãy gửi email đến {contact} từ địa chỉ liên kết với tài khoản.</p>
    <p>MangaHub có thể cần xác minh chủ tài khoản trước khi xử lý yêu cầu để tránh tiết lộ hoặc xóa dữ liệu của người khác. Bạn vẫn có thể đọc chính sách này và liên hệ qua email khi tài khoản bị khóa hoặc không nằm trong danh sách được cấp quyền.</p>
  </> },
];

const termsSections: Section[] = [
  { id: "pham-vi", title: "Phạm vi sử dụng", content: <>
    <p>MangaHub cung cấp giao diện khám phá, đọc truyện và các tính năng cộng đồng. Khi sử dụng website, bạn cần đọc các điều khoản này, tôn trọng người khác và sử dụng dịch vụ đúng mục đích.</p>
    <p>Nội dung, tính năng và khả năng truy cập có thể thay đổi theo tình trạng nguồn truyện, bảo trì và thiết lập của website. Không truy cập nội dung không phù hợp với độ tuổi của bạn; hãy sử dụng bộ lọc nội dung khi cần.</p>
  </> },
  { id: "tai-khoan", title: "Tài khoản và bảo mật", content: <>
    <p>Bạn có trách nhiệm cung cấp thông tin tài khoản phù hợp, bảo vệ mật khẩu, mã xác minh và phiên đăng nhập. Không mạo danh người khác, sử dụng tài khoản trái phép hoặc chia sẻ thông tin đăng nhập để vượt qua giới hạn truy cập.</p>
    <p>Nếu phát hiện hoạt động bất thường hoặc mất quyền kiểm soát tài khoản, hãy liên hệ {contact}. Một số thao tác có thể yêu cầu xác minh email, reCAPTCHA hoặc xác nhận lại danh tính.</p>
  </> },
  { id: "cong-dong", title: "Quy tắc cộng đồng", content: <>
    <p>Không đăng spam, liên kết lừa đảo, mã độc, thông tin cá nhân của người khác, nội dung đe dọa, quấy rối hoặc xâm phạm quyền của người khác. Không thao túng lượt xem, đánh giá hay lợi dụng biểu mẫu hỗ trợ.</p>
    <p>Không dò quét, tấn công, gây quá tải hoặc tìm cách vượt cơ chế xác thực và phân quyền của website. Khi phát hiện lỗi bảo mật, hãy báo riêng qua email hỗ trợ và không công khai thông tin nhạy cảm của tài khoản khác.</p>
  </> },
  { id: "noi-dung", title: "Nội dung và bản quyền", content: <>
    <p>Quyền đối với tác phẩm, hình ảnh và bản dịch thuộc về chủ sở hữu hoặc người có quyền tương ứng. Việc nội dung xuất hiện trên MangaHub không đồng nghĩa bạn được phép sao chép, phân phối hoặc sử dụng thương mại nội dung đó.</p>
    <p>Chỉ tải lên hoặc chia sẻ nội dung mà bạn có quyền sử dụng. Nếu cần phản ánh vấn đề bản quyền, gửi đường dẫn nội dung, mô tả yêu cầu và thông tin chứng minh quyền liên quan đến {contact} để được xem xét.</p>
  </> },
  { id: "quyen-truy-cap", title: "Giới hạn và xử lý quyền truy cập", content: <>
    <p>Website có thể giới hạn truy cập theo tài khoản được cấp quyền, vai trò, tình trạng bảo trì hoặc biện pháp chống lạm dụng. MangaHub có thể ẩn nội dung, thu hồi quyền hoặc khóa tài khoản khi phát hiện vi phạm hay cần bảo vệ hệ thống.</p>
    <p>Nếu cho rằng việc hạn chế là nhầm lẫn, bạn có thể gửi email đề nghị xem xét lại. Trang Chính sách riêng tư và Điều khoản sử dụng luôn có thể mở mà không cần được cấp quyền; đọc các trang này không khôi phục quyền truy cập truyện hoặc chức năng bị hạn chế.</p>
  </> },
  { id: "nguon-ben-ngoai", title: "Nguồn và dịch vụ bên ngoài", content: <>
    <p>Truyện, ảnh, liên kết hoặc chức năng đăng nhập có thể phụ thuộc dịch vụ bên ngoài. Nội dung có thể bị thay đổi, gỡ bỏ hoặc tạm thời không tải được. Khi truy cập dịch vụ khác, bạn cần xem điều khoản và chính sách riêng của dịch vụ đó.</p>
    <p>MangaHub tiếp nhận phản ánh để kiểm tra vấn đề trong phạm vi website vận hành. Gửi đường dẫn và mô tả cụ thể sẽ giúp việc xử lý chính xác hơn.</p>
  </> },
  { id: "thay-doi", title: "Cập nhật và liên hệ", content: <>
    <p>Điều khoản có thể được cập nhật để phản ánh tính năng và cách vận hành website. Ngày cập nhật hiển thị ở đầu trang giúp bạn nhận biết phiên bản đang đọc.</p>
    <p>Thông tin về cách xử lý dữ liệu được mô tả trong <Link to="/privacy" className={outsideLink}>Chính sách riêng tư</Link>. Mọi câu hỏi, phản ánh nội dung hoặc yêu cầu xem xét tài khoản có thể gửi đến {contact}.</p>
  </> },
];

export default function LegalPage({ document: kind }: { document: "privacy" | "terms" }) {
  const { hash } = useLocation();
  const privacy = kind === "privacy";
  const title = privacy ? "Chính sách riêng tư" : "Điều khoản sử dụng";
  const sections = privacy ? privacySections : termsSections;
  const Icon = privacy ? ShieldCheck : FileText;
  useEffect(() => {
    const previous = window.document.title;
    window.document.title = `${title} · MangaHub`;
    return () => { window.document.title = previous; };
  }, [title]);
  useEffect(() => {
    const target = hash ? window.document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [kind, hash]);
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5 px-6 py-6 sm:px-10">
          <BrandLogo />
          <LegalLinks />
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-6xl px-6 pb-16 pt-12 sm:px-10 sm:pt-16">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary"><Icon className="h-4 w-4" aria-hidden="true" />Thông tin & chính sách</span>
          <h1 className="ed-heading mt-5 text-4xl leading-tight sm:text-5xl">{title}</h1>
          <p className="mt-5 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">{privacy ? "Hiểu cách MangaHub xử lý thông tin của bạn và những lựa chọn bạn có khi sử dụng website." : "Những nguyên tắc để cùng xây dựng một không gian đọc truyện an toàn, tôn trọng và dễ sử dụng."}</p>
          <p className="mt-5 text-xs text-muted-foreground">Cập nhật ngày <time dateTime="2026-10-21">21/10/2026</time></p>
        </div>
        <div className="mt-10 grid items-start gap-10 border-t border-border pt-8 lg:mt-14 lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-16">
          <aside className="lg:sticky lg:top-8">
            <nav aria-label="Mục lục" className="rounded-xl border border-border bg-card p-5">
              <p className="mb-4 text-xs font-bold uppercase tracking-wider text-foreground">Trong trang này</p>
              <ol className="space-y-3">{sections.map((section, index) => <li key={section.id}><a href={`#${section.id}`} className="flex gap-3 rounded text-xs leading-5 text-muted-foreground hover:text-primary focus-visible:outline focus-visible:outline-primary"><span className="tabular-nums text-primary/70">{String(index + 1).padStart(2, "0")}</span>{section.title}</a></li>)}</ol>
            </nav>
          </aside>
          <article className="min-w-0 max-w-3xl space-y-10">
            {sections.map((section, index) => <section key={section.id} id={section.id} className="scroll-mt-8">
              <h2 className="flex items-baseline gap-3 text-lg font-semibold"><span className="text-xs font-normal tabular-nums text-primary">{String(index + 1).padStart(2, "0")}</span>{section.title}</h2>
              <div className="mt-4 space-y-4 break-words text-sm leading-7 text-muted-foreground">{section.content}</div>
            </section>)}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 text-sm font-semibold"><Mail className="h-4 w-4 text-primary" aria-hidden="true" />Bạn cần hỗ trợ?</div>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">Bạn vẫn có thể liên hệ qua email khi không đăng nhập được hoặc tài khoản đang bị hạn chế.</p>
              <a href={supportMailto(privacy ? "Yêu cầu về quyền riêng tư" : "Câu hỏi về điều khoản sử dụng")} className="mt-4 inline-flex items-center gap-2 break-all text-sm font-medium text-primary underline-offset-4 hover:underline">{SUPPORT_EMAIL}<ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" /></a>
            </div>
          </article>
        </div>
      </main>
      <footer className="border-t border-border px-6 py-7 sm:px-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5">
          <Link to="/" className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Về MangaHub</Link>
          <LegalLinks />
          <span className="text-xs text-muted-foreground">© 2026 MangaHub</span>
        </div>
      </footer>
    </div>
  );
}
