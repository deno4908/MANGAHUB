import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  size?: "nav" | "auth";
  to?: string;
};

const sizeClass = {
  nav: "text-xl",
  auth: "text-3xl md:text-4xl",
};

const BrandLogo = ({ className, size = "nav", to = "/" }: BrandLogoProps) => (
  <Link
    to={to}
    aria-label="MangaHub"
    className={cn("inline-flex items-baseline gap-0.5 shrink-0", className)}
  >
    <span className={cn(sizeClass[size], "font-serif italic font-semibold text-foreground")}>
      Manga
    </span>
    <span className={cn(sizeClass[size], "font-extrabold text-primary tracking-tight")}>
      Hub
    </span>
  </Link>
);

export default BrandLogo;
