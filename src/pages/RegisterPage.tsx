import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, EyeOff, Mail, Lock, User, CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { authApi } from "@/lib/api";
import BrandLogo from "@/components/manga/BrandLogo";
import ReCaptchaV2, { isRecaptchaConfigured, type ReCaptchaV2Handle } from "@/components/security/ReCaptchaV2";

const RegisterPage = () => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [loading, setLoading] = useState(false);
  const captchaRef = useRef<ReCaptchaV2Handle>(null);
  const captchaRequired = isRecaptchaConfigured();
  const { toast } = useToast();
  const navigate = useNavigate();
  const hasUsernameWhitespace = /\s/.test(name);

  const usernameChecks = useMemo(
    () => [
      { label: "Không chứa khoảng trắng", valid: name.length > 0 && !hasUsernameWhitespace, key: "no-whitespace" as const },
      { label: "Chỉ dùng chữ, số, dấu chấm, gạch dưới hoặc gạch ngang", valid: /^[A-Za-z0-9._-]+$/.test(name) },
    ],
    [hasUsernameWhitespace, name],
  );

  const passwordChecks = useMemo(
    () => [
      { label: "Từ 15 đến 128 ký tự; có thể dùng một cụm từ dài", valid: Array.from(password).length >= 15 && Array.from(password).length <= 128 },
    ],
    [password],
  );

  const isPasswordStrong = passwordChecks.every((rule) => rule.valid);
  const isPasswordMatch = password === confirmPassword;
  const isUsernameValid = usernameChecks.every((rule) => rule.valid);
  const canSubmit =
    !loading &&
    name.trim().length > 0 &&
    isUsernameValid &&
    email.trim().length > 0 &&
    isPasswordStrong &&
    isPasswordMatch &&
    (!captchaRequired || Boolean(captchaToken));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isUsernameValid) {
      toast({
        title: "Username không hợp lệ",
        description: "Username không chứa khoảng trắng và chỉ dùng chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.",
        variant: "destructive",
      });
      return;
    }

    if (!isPasswordStrong) {
      toast({
        title: "Mật khẩu chưa đủ mạnh",
        description: "Vui lòng đạt đủ tất cả điều kiện mật khẩu.",
        variant: "destructive",
      });
      return;
    }

    if (!isPasswordMatch) {
      toast({ title: "Lỗi", description: "Mật khẩu không khớp!", variant: "destructive" });
      return;
    }

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
      await authApi.register(email, password, name, name, captchaToken);
      toast({
        title: "Đăng ký thành công! 🎉",
        description: "Kiểm tra email để xác nhận tài khoản, sau đó đăng nhập.",
      });
      navigate("/login");
    } catch (err: any) {
      toast({
        title: "Đăng ký thất bại",
        description: err.message || "Có lỗi xảy ra, vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      captchaRef.current?.reset();
      setLoading(false);
    }
  };

  const handleGoogleSignup = async () => {
    setLoading(true);
    try {
      const data = await authApi.googleLogin();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      toast({
        title: "Lỗi",
        description: data.error || "Không thể kết nối Google.",
        variant: "destructive",
      });
    } catch (err: any) {
      toast({
        title: "Lỗi",
        description: err.message || "Không thể đăng ký bằng Google.",
        variant: "destructive",
      });
    } finally {
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
          <p className="mt-3 text-muted-foreground text-sm">Tạo tài khoản để khám phá kho truyện</p>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl p-8 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Username</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="username"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="pl-10"
                  required
                />
              </div>

              <AnimatePresence>
                {name.length > 0 && (
                  <motion.ul
                    initial={{ opacity: 0, height: 0, marginTop: 0 }}
                    animate={{ opacity: 1, height: "auto", marginTop: 8 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                    className="space-y-1.5 rounded-md border border-border bg-muted/40 p-3 overflow-hidden"
                  >
                    {usernameChecks.map((rule, i) => (
                      <motion.li
                        key={rule.label}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.05, duration: 0.2 }}
                        className={`flex items-center gap-2 text-xs transition-colors duration-200 ${
                          rule.valid
                            ? "text-primary"
                            : rule.key === "no-whitespace" && hasUsernameWhitespace
                              ? "text-destructive"
                              : "text-muted-foreground"
                        }`}
                      >
                        <motion.span
                          animate={{ scale: rule.valid ? [1, 1.3, 1] : 1 }}
                          transition={{ duration: 0.2 }}
                        >
                          {rule.valid ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : rule.key === "no-whitespace" && hasUsernameWhitespace ? (
                            <span className="inline-flex h-3.5 w-3.5 items-center justify-center text-[11px] font-bold leading-none">x</span>
                          ) : (
                            <Circle className="h-3.5 w-3.5" />
                          )}
                        </motion.span>
                        <span>{rule.label}</span>
                      </motion.li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>

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
              <label className="text-sm font-medium text-foreground">Mật khẩu</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Tối thiểu 15 ký tự"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-10"
                  minLength={15}
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

              <AnimatePresence>
                {password.length > 0 && (
                  <motion.ul
                    initial={{ opacity: 0, height: 0, marginTop: 0 }}
                    animate={{ opacity: 1, height: "auto", marginTop: 8 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                    className="space-y-1.5 rounded-md border border-border bg-muted/40 p-3 overflow-hidden"
                  >
                    {passwordChecks.map((rule, i) => (
                      <motion.li
                        key={rule.label}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.05, duration: 0.2 }}
                        className={`flex items-center gap-2 text-xs transition-colors duration-200 ${rule.valid ? "text-primary" : "text-muted-foreground"}`}
                      >
                        <motion.span
                          animate={{ scale: rule.valid ? [1, 1.3, 1] : 1 }}
                          transition={{ duration: 0.2 }}
                        >
                          {rule.valid ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                        </motion.span>
                        <span>{rule.label}</span>
                      </motion.li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Xác nhận mật khẩu</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Nhập lại mật khẩu"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="pl-10"
                  minLength={15}
                  required
                />
              </div>
              <AnimatePresence>
                {confirmPassword.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className={`flex items-center gap-2 text-xs mt-1.5 ${isPasswordMatch ? "text-primary" : "text-destructive"}`}
                  >
                    {isPasswordMatch ? (
                      <><CheckCircle2 className="h-3.5 w-3.5" /> Mật khẩu khớp</>
                    ) : (
                      <><Circle className="h-3.5 w-3.5" /> Mật khẩu không khớp</>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <ReCaptchaV2 ref={captchaRef} onTokenChange={setCaptchaToken} />

            <Button type="submit" className="w-full h-11 font-bold" disabled={!canSubmit}>
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  Đang tạo tài khoản...
                </span>
              ) : (
                "Đăng ký"
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
          <Button variant="outline" className="w-full h-11 gap-2" disabled={loading} onClick={handleGoogleSignup}>
            <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Đăng ký với Google
          </Button>
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-muted-foreground mt-6">
          Đã có tài khoản?{" "}
          <Link to="/login" className="text-primary font-semibold hover:underline">
            Đăng nhập
          </Link>
        </p>
      </motion.div>
    </div>
  );
};

export default RegisterPage;
