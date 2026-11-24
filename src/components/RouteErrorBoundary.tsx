import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Home, RefreshCw } from 'lucide-react';
import { retryFailedPages } from '@/lib/lazyPage';

type RouteErrorBoundaryProps = {
  children: ReactNode;
  resetKey: string;
};

type RouteErrorBoundaryState = {
  hasError: boolean;
};

export default class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: RouteErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Route render failed", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4 py-12 text-center">
        <section role="alert" aria-labelledby="route-error-title" className="relative w-full max-w-md overflow-hidden rounded-3xl border border-border/70 bg-card px-6 py-9 shadow-xl shadow-black/5 sm:px-10 sm:py-11 dark:shadow-black/20">
          <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
          <div aria-hidden="true" className="relative mx-auto mb-7 flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/15 bg-primary/5">
            <BookOpen className="h-9 w-9 text-primary" strokeWidth={1.5} />
            <span className="absolute -bottom-1.5 -right-1.5 flex h-8 w-8 items-center justify-center rounded-full border-4 border-card bg-secondary text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5" />
            </span>
          </div>
          <h1 id="route-error-title" className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Không thể tải trang này.</h1>
          <p className="mx-auto mt-3 max-w-xs text-sm leading-7 text-muted-foreground">
            Trang gặp lỗi tải dữ liệu hoặc kết nối. Bạn có thể thử lại mà không cần tải lại toàn bộ website.
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => { retryFailedPages(); this.setState({ hasError: false }); }}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              <RefreshCw className="h-4 w-4" />
              Thử lại
            </button>
            <button type="button" onClick={() => window.location.reload()} className="text-sm text-muted-foreground underline underline-offset-4">Tải lại trang</button>
            <Link to="/" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background/50 px-5 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card">
              <Home className="h-4 w-4" /> Về trang chủ
            </Link>
          </div>
        </section>
      </div>
    );
  }
}

