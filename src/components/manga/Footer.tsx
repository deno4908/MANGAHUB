import { Link } from 'react-router-dom';
import { Facebook } from 'lucide-react';
import LegalLinks from '@/components/LegalLinks';

const DiscordIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.001.025.015.049.033.063a19.963 19.963 0 0 0 6.002 3.033.077.077 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.201 13.201 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.033.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

const Footer = () => (
  <footer className="border-t border-border mt-16 py-8">
    <div className="container mx-auto px-4">
      <div className="grid gap-8 md:grid-cols-[1.1fr_1fr_1fr_auto]">
        <div>
          <Link to="/" className="inline-flex items-baseline gap-0.5">
            <span className="text-sm font-serif italic font-semibold text-foreground">Manga</span>
            <span className="text-sm font-extrabold text-primary tracking-tight">Hub</span>
          </Link>
          <p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground">
            Nền tảng đọc truyện trực tuyến, tổng hợp nhiều nguồn và tối ưu trải nghiệm đọc.
          </p>
        </div>

        <nav className="space-y-2 text-xs font-medium text-muted-foreground" aria-label="Khám phá">
          <h2 className="text-xs font-bold uppercase tracking-wide text-foreground">Khám phá</h2>
          <Link to="/" className="block hover:text-foreground transition-colors">Trang chủ</Link>
          <Link to="/manga" className="block hover:text-foreground transition-colors">Truyện</Link>
          <Link to="/rankings" className="block hover:text-foreground transition-colors">Bảng xếp hạng</Link>
          <Link to="/search" className="block hover:text-foreground transition-colors">Tìm kiếm</Link>
        </nav>

        <nav className="space-y-2 text-xs font-medium text-muted-foreground" aria-label="Hỗ trợ">
          <h2 className="text-xs font-bold uppercase tracking-wide text-foreground">Hỗ trợ</h2>
          <Link to="/faq" className="block hover:text-foreground transition-colors">FAQ</Link>
          <Link to="/contact" className="block hover:text-foreground transition-colors">Liên hệ</Link>
          <Link to="/support" className="block hover:text-foreground transition-colors">Gửi ticket</Link>
          <Link to="/disclaimer" className="block hover:text-foreground transition-colors">Miễn trừ trách nhiệm</Link>
          <Link to="/about" className="block hover:text-foreground transition-colors">Về MangaHub</Link>
        </nav>

        <div className="flex items-start gap-3">
          <a
            href="https://facebook.com"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Facebook"
            className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Facebook className="w-4 h-4" />
          </a>
          <a
            href="https://discord.gg"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Discord"
            className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <DiscordIcon className="w-4 h-4" />
          </a>
        </div>
      </div>

      <LegalLinks className="mt-8 justify-center" />
      <p className="mt-5 border-t border-border/60 pt-5 text-center text-xs text-muted-foreground/50">
        © 2026 MangaHub
      </p>
    </div>
  </footer>
);

export default Footer;
