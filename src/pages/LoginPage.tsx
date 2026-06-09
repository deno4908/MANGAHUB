import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Eye, EyeOff, Mail, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useUserStore } from "@/store/userStore";
import BrandLogo from "@/components/manga/BrandLogo";
import ReCaptchaV2, { isRecaptchaConfigured, type ReCaptchaV2Handle } from "@/components/security/ReCaptchaV2";

const LoginPage = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [loading, setLoading] = useState(false);
  const captchaRef = useRef<ReCaptchaV2Handle>(null);
  const captchaRequired = isRecaptchaConfigured();
  const { toast } = useToast();
  const navigate = useNavigate();
  const login = useUserStore(s => s.login);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (captchaRequired && !captchaToken) {
      toast({
        title: "Thiếu reCAPTCHA",
        description: "Vui lòng xác minh bạn không phải robot.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    try {
      const result = await login(email, password, captchaToken);
      if (result.success) {
        toast({ title: "Đăng nhập thành công!", description: "Chào mừng bạn trở lại." });
        navigate("/");
      } else {
        toast({
          title: "Đăng nhập thất bại",
          description: result.error || "Email hoặc mật khẩu không đúng.",
          variant: "destructive",
        });
      }
    } catch (err: any) {
      toast({
        title: "Đăng nhập thất bại",
        description: err.message || "Có lỗi xảy ra, vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      captchaRef.current?.reset();
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-background px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <BrandLogo size="auth" />
          <p className="mt-3 text-muted-foreground text-sm">Đăng nhập để tiếp tục đọc truyện</p>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl p-8 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-foreground">Mật khẩu</label>
                <Link to="/forgot-password" className="text-xs text-primary hover:underline">
                  Quên mật khẩu?
                </Link>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-10"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <ReCaptchaV2 ref={captchaRef} onTokenChange={setCaptchaToken} />

            <Button type="submit" className="w-full h-11 font-bold" disabled={loading || (captchaRequired && !captchaToken)}>
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  Đang đăng nhập...
                </span>
              ) : (
                "Đăng nhập"
              )}
            </Button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">hoặc</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* Social */}
          <div className="space-y-3">
            <Button variant="outline" className="w-full h-11 gap-2" disabled={loading} onClick={async () => {
              setLoading(true);
              try {
                const { authApi } = await import("@/lib/api");
                const data = await authApi.googleLogin();
                if (data.url) {
                  window.location.href = data.url;
                } else {
                  toast({ title: "Lỗi", description: data.error || "Không thể kết nối Google.", variant: "destructive" });
                  setLoading(false);
                }
              } catch (err: any) {
                toast({ title: "Lỗi", description: err.message || "Không thể đăng nhập Google.", variant: "destructive" });
                setLoading(false);
              }
            }}>
              <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Đăng nhập với Google
            </Button>
            <Button variant="outline" className="w-full h-11 gap-2" disabled={loading} onClick={async () => {
              setLoading(true);
              try {
                const { authApi } = await import("@/lib/api");
                const data = await authApi.discordLogin();
                if (data.url) {
                  window.location.href = data.url;
                } else {
                  toast({ title: "Lỗi", description: data.error || "Không thể kết nối Discord.", variant: "destructive" });
                  setLoading(false);
                }
              } catch (err: any) {
                toast({ title: "Lỗi", description: err.message || "Không thể đăng nhập Discord.", variant: "destructive" });
                setLoading(false);
              }
            }}>
              <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#5865F2" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              Đăng nhập với Discord
            </Button>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-muted-foreground mt-6">
          Chưa có tài khoản?{" "}
          <Link to="/register" className="text-primary font-semibold hover:underline">
            Đăng ký ngay
          </Link>
        </p>
      </motion.div>
    </div>
  );
};

export default LoginPage;
