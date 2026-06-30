import { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertCircle, ArrowLeft, Lock, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { authApi, clearTokens, setTokens } from "@/lib/api";
import BrandLogo from "@/components/manga/BrandLogo";

/**
 * This page handles two flows:
 *
 * 1. Supabase email LINK redirect:
 *    User clicks link in email → redirected here with tokens in URL hash
 *    e.g. /auth/callback#access_token=xxx&refresh_token=yyy&type=recovery
 *    → auto-extract tokens, show password reset form
 *
 * 2. Manual navigation from forgot-password page
 *    → show waiting message, tell user to check email and click link
 */
const VerifyOtpPage = () => {
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [retryingOAuth, setRetryingOAuth] = useState(false);
  const [callbackError, setCallbackError] = useState<{
    title: string;
    message: string;
    detail?: string;
  } | null>(null);
  const [searchParams] = useSearchParams();
  const email = searchParams.get("email") || "";
  const navigate = useNavigate();
  const { toast } = useToast();

  // Handle OAuth redirect — supports both PKCE (?code=) and implicit (#access_token=)
  useEffect(() => {
    const hash = window.location.hash.substring(1);
    const error = searchParams.get("error");
    const errorCode = searchParams.get("error_code");
    const errorDescription = searchParams.get("error_description");
    const code = searchParams.get("code");

    if (error || errorCode || errorDescription) {
      const description = errorDescription || errorCode || error || "OAuth failed";
      const isBadState =
        errorCode === "bad_oauth_state" ||
        description.toLowerCase().includes("state not found") ||
        description.toLowerCase().includes("expired");

      setCallbackError({
        title: "Đăng nhập Google không hoàn tất",
        message: isBadState
          ? "Phiên đăng nhập Google đã hết hạn hoặc bị mở lại từ liên kết cũ. Vui lòng bắt đầu đăng nhập lại để tạo phiên mới."
          : "Nhà cung cấp đăng nhập trả về lỗi. Vui lòng thử đăng nhập lại.",
        detail: description,
      });
      setLoading(false);
      return;
    }

    // --- PKCE flow: ?code=xxx ---
    if (code) {
      window.history.replaceState(null, "", window.location.pathname);
      (async () => {
        try {
          const data = await authApi.oauthExchangeCode(code);
          if (data.profile) {
            const { useUserStore } = await import("@/store/userStore");
            await useUserStore.getState().loadUser({ force: true });
            toast({ title: "Đăng nhập thành công!", description: "Chào mừng bạn!" });
            navigate("/");
          } else if (data.error === "BANNED") {
            navigate("/banned");
          } else {
            toast({ title: "Lỗi", description: data.error || "Đăng nhập thất bại", variant: "destructive" });
            navigate("/login");
          }
        } catch (err: any) {
          toast({ title: "Lỗi", description: err.message || "OAuth thất bại", variant: "destructive" });
          navigate("/login");
        } finally {
          setLoading(false);
        }
      })();
      return;
    }

    // --- Implicit flow: #access_token=xxx ---
    if (!hash) {
      setLoading(false);
      return;
    }

    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const type = params.get("type");

    if (accessToken) {
      window.history.replaceState(null, "", window.location.pathname);

      if (type === "recovery") {
        if (refreshToken) setTokens(accessToken, refreshToken);
        setVerified(true);
        toast({ title: "Xác minh thành công!", description: "Đặt mật khẩu mới bên dưới." });
        setLoading(false);
      } else if (type === "signup") {
        toast({ title: "Xác thực email thành công!", description: "Bạn có thể đăng nhập ngay." });
        setLoading(false);
        setTimeout(() => navigate("/login"), 1500);
      } else {
        // OAuth implicit flow
        (async () => {
          try {
            const data = await authApi.oauthCallback(accessToken, refreshToken || "");
            if (data.profile) {
              const { useUserStore } = await import("@/store/userStore");
              await useUserStore.getState().loadUser({ force: true });
              toast({ title: "Đăng nhập thành công!", description: "Chào mừng bạn!" });
              navigate("/");
            } else if (data.error === "BANNED") {
              navigate("/banned");
            } else {
              toast({ title: "Lỗi", description: data.error || "Đăng nhập thất bại", variant: "destructive" });
              navigate("/login");
            }
          } catch (err: any) {
            toast({ title: "Lỗi", description: err.message || "OAuth callback thất bại", variant: "destructive" });
            navigate("/login");
          } finally {
            setLoading(false);
          }
        })();
      }
    } else {
      setLoading(false);
    }
  }, []);

  const handleRetryGoogleLogin = async () => {
    setRetryingOAuth(true);
    try {
      const data = await authApi.googleLogin();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      toast({
        title: "Lỗi",
        description: data.error || "Không thể bắt đầu đăng nhập Google.",
        variant: "destructive",
      });
    } catch (err: any) {
      toast({
        title: "Lỗi",
        description: err.message || "Không thể bắt đầu đăng nhập Google.",
        variant: "destructive",
      });
    } finally {
      setRetryingOAuth(false);
    }
  };

  const handleResetPassword = async () => {
    if (!newPassword || newPassword.length < 8) {
      toast({ variant: "destructive", title: "Mật khẩu quá ngắn", description: "Mật khẩu phải ít nhất 8 ký tự." });
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      toast({ variant: "destructive", title: "Mật khẩu chưa đủ mạnh", description: "Mật khẩu cần có chữ hoa, chữ thường và số." });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ variant: "destructive", title: "Mật khẩu không khớp", description: "Vui lòng nhập lại xác nhận mật khẩu." });
      return;
    }
    setResetting(true);
    try {
      await authApi.resetPassword(newPassword);
      clearTokens();
      toast({ title: "Đặt lại mật khẩu thành công!", description: "Đang chuyển hướng về trang đăng nhập..." });
      setTimeout(() => navigate("/login"), 2000);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Lỗi", description: err.message || "Không thể đặt lại mật khẩu." });
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <BrandLogo size="auth" />
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl p-8 shadow-sm">
          {callbackError ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-5"
            >
              <div className="text-center">
                <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
                  <AlertCircle className="w-7 h-7 text-destructive" />
                </div>
                <h2 className="text-xl font-bold text-foreground">{callbackError.title}</h2>
                <p className="text-sm text-muted-foreground mt-2">{callbackError.message}</p>
              </div>

              {callbackError.detail && (
                <div className="rounded-xl border border-border bg-secondary/30 p-3">
                  <p className="text-xs font-medium text-muted-foreground break-words">
                    {callbackError.detail}
                  </p>
                </div>
              )}

              <Button
                onClick={handleRetryGoogleLogin}
                className="w-full h-11 font-bold"
                disabled={retryingOAuth}
              >
                {retryingOAuth ? (
                  <span className="flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                    Đang mở Google...
                  </span>
                ) : (
                  "Thử đăng nhập Google lại"
                )}
              </Button>

              <Button
                variant="outline"
                className="w-full h-11 font-bold"
                onClick={() => navigate("/login", { replace: true })}
              >
                Quay lại đăng nhập
              </Button>
            </motion.div>
          ) : verified ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-5"
            >
              <div className="text-center">
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <Lock className="w-7 h-7 text-primary" />
                </div>
                <h2 className="text-xl font-bold text-foreground">Đặt mật khẩu mới</h2>
                <p className="text-sm text-muted-foreground mt-2">Nhập mật khẩu mới cho tài khoản của bạn.</p>
              </div>
              <div className="space-y-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Mật khẩu mới</label>
                  <Input type="password" placeholder="Ít nhất 8 ký tự" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Xác nhận mật khẩu</label>
                  <Input type="password" placeholder="Nhập lại mật khẩu" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
                </div>
              </div>
              <Button onClick={handleResetPassword} className="w-full h-11 font-bold" disabled={resetting || !newPassword || !confirmPassword}>
                {resetting ? (
                  <span className="flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                    Đang lưu...
                  </span>
                ) : "Đặt lại mật khẩu"}
              </Button>
            </motion.div>
          ) : (
            <>
              <div className="text-center mb-6">
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-7 h-7 text-primary" />
                </div>
                <h2 className="text-xl font-bold text-foreground">Kiểm tra email</h2>
                <p className="text-sm text-muted-foreground mt-2">
                  Chúng tôi đã gửi một <strong>link xác minh</strong> tới{" "}
                  {email ? (
                    <span className="font-semibold text-foreground">{email}</span>
                  ) : (
                    "email của bạn"
                  )}
                  .
                </p>
                <p className="text-sm text-muted-foreground mt-3">
                  Vui lòng mở email và <strong>bấm vào link</strong> trong email để tiếp tục.
                </p>
              </div>

              <div className="bg-secondary/30 rounded-xl p-4 text-center space-y-2 mb-6">
                <p className="text-xs text-muted-foreground">Không thấy email?</p>
                <ul className="text-xs text-muted-foreground space-y-1 text-left list-disc list-inside">
                  <li>Kiểm tra thư mục <strong>Spam</strong> hoặc <strong>Quảng cáo</strong></li>
                  <li>Đợi 1-2 phút</li>
                  <li>Thử gửi lại bên dưới</li>
                </ul>
              </div>

              <Button
                variant="outline"
                className="w-full h-11 font-bold"
                onClick={async () => {
                  if (!email) {
                    navigate("/forgot-password");
                    return;
                  }
                  try {
                    await authApi.forgotPassword(email);
                    toast({ title: "Đã gửi lại email", description: `Link mới đã được gửi tới ${email}.` });
                  } catch {
                    toast({ variant: "destructive", title: "Lỗi", description: "Không thể gửi lại email." });
                  }
                }}
              >
                Gửi lại link xác minh
              </Button>
            </>
          )}
        </div>

        {/* Back */}
        <div className="text-center mt-6">
          <Link
            to={callbackError ? "/login" : "/forgot-password"}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Quay lại
          </Link>
        </div>
      </motion.div>
    </div>
  );
};

export default VerifyOtpPage;
