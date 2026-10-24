import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Mail, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { authApi } from "@/lib/api";
import BrandLogo from "@/components/manga/BrandLogo";
import { NewPasswordFields, usePasswordAssessment } from '@/components/security/NewPasswordFields';
import ReCaptchaV2, { isRecaptchaConfigured, type ReCaptchaV2Handle } from "@/components/security/ReCaptchaV2";

const RegisterPage = () => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [loading, setLoading] = useState(false);
  const captchaRef = useRef<ReCaptchaV2Handle>(null);
  const captchaRequired = isRecaptchaConfigured();
  const { toast } = useToast();
  const navigate = useNavigate();

  const assessment = usePasswordAssessment(password);
  const isPasswordStrong = assessment.accepted;
  const isPasswordMatch = password === confirmPassword;
  const canSubmit =
    !loading &&
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    isPasswordStrong &&
    isPasswordMatch &&
    (!captchaRequired || Boolean(captchaToken));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

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
              <label htmlFor="register-username" className="text-sm font-medium text-foreground">Username</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="register-username"
                  type="text"
                  placeholder="username"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="pl-10"
                  required
                />
              </div>

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

            <NewPasswordFields passwordLabel="Mật khẩu" password={password} confirmation={confirmPassword}
              onPasswordChange={setPassword} onConfirmationChange={setConfirmPassword} assessment={assessment}
              disabled={loading} />

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
