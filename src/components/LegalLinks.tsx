import { Link } from "react-router-dom";

export default function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Chính sách MangaHub" className={`flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground ${className}`}>
      <Link to="/privacy" className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-primary">Chính sách riêng tư</Link>
      <Link to="/terms" className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-primary">Điều khoản sử dụng</Link>
    </nav>
  );
}
