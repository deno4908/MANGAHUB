import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { motion } from "framer-motion";
import { FileQuestion, Home, ArrowLeft } from "lucide-react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center max-w-md"
      >
        <div className="mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-6">
          <FileQuestion className="w-8 h-8 text-muted-foreground" />
        </div>
        <h1 className="text-6xl font-black text-foreground mb-2">404</h1>
        <p className="text-lg text-muted-foreground font-medium mb-1">Trang không tồn tại</p>
        <p className="text-sm text-muted-foreground mb-8">
          Trang bạn đang tìm kiếm có thể đã bị xóa hoặc đường dẫn không chính xác.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => window.history.back()}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-secondary text-sm font-bold hover:bg-secondary/80 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Quay lại
          </button>
          <Link
            to="/"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors"
          >
            <Home className="w-4 h-4" /> Trang chủ
          </Link>
        </div>
      </motion.div>
    </div>
  );
};

export default NotFound;
