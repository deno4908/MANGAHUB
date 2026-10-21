import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

type GrecaptchaApi = {
  render: (
    container: HTMLElement,
    params: {
      sitekey: string;
      theme?: "light" | "dark";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => number;
  reset: (widgetId?: number) => void;
};

declare global {
  interface Window {
    grecaptcha?: GrecaptchaApi;
    __mangahubRecaptchaScript?: Promise<void>;
  }
}

export type ReCaptchaV2Handle = {
  reset: () => void;
};

type ReCaptchaV2Props = {
  onTokenChange: (token: string) => void;
  theme?: "light" | "dark";
  className?: string;
};

export const getRecaptchaSiteKey = () =>
  String(import.meta.env.VITE_RECAPTCHA_SITE_KEY || "").trim();

export const isRecaptchaConfigured = () => Boolean(getRecaptchaSiteKey());

function isRecaptchaReady(): boolean {
  return (
    typeof window.grecaptcha?.render === "function" &&
    typeof window.grecaptcha?.reset === "function"
  );
}

function loadRecaptchaScript() {
  if (isRecaptchaReady()) return Promise.resolve();
  if (window.__mangahubRecaptchaScript) return window.__mangahubRecaptchaScript;

  window.__mangahubRecaptchaScript = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-mangahub-recaptcha="true"]',
    );
    const script = existing || document.createElement("script");
    const finish = (error?: Error) => {
      clearInterval(poll);
      clearTimeout(deadline);
      script.removeEventListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const failed = () => finish(new Error("reCAPTCHA load failed"));
    const poll = window.setInterval(() => { if (isRecaptchaReady()) finish(); }, 50);
    // Bound the entire script load, including a request that never fires onload.
    const deadline = window.setTimeout(() => finish(new Error("reCAPTCHA load timed out")), 12_000);
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.src = "https://www.google.com/recaptcha/api.js?render=explicit&hl=vi";
      script.async = true;
      script.defer = true;
      script.dataset.mangahubRecaptcha = "true";
      document.head.appendChild(script);
    }
  }).catch((error) => {
    document.querySelector('script[data-mangahub-recaptcha="true"]')?.remove();
    window.__mangahubRecaptchaScript = undefined;
    throw error;
  });

  return window.__mangahubRecaptchaScript;
}

const ReCaptchaV2 = forwardRef<ReCaptchaV2Handle, ReCaptchaV2Props>(
  ({ onTokenChange, theme = "light", className = "" }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const widgetIdRef = useRef<number | null>(null);
    const onTokenChangeRef = useRef(onTokenChange);
    const siteKey = getRecaptchaSiteKey();
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [attempt, setAttempt] = useState(0);

    onTokenChangeRef.current = onTokenChange;

    const reset = () => {
      if (widgetIdRef.current !== null && window.grecaptcha) {
        try { window.grecaptcha.reset(widgetIdRef.current); }
        catch { setStatus("error"); }
      }
      onTokenChangeRef.current("");
    };

    useImperativeHandle(ref, () => ({ reset }));

    useEffect(() => {
      if (!siteKey) {
        onTokenChangeRef.current("");
        return;
      }

      let cancelled = false;
      setStatus("loading");
      onTokenChangeRef.current("");
      const widget = document.createElement("div");
      containerRef.current?.replaceChildren(widget);
      loadRecaptchaScript()
        .then(() => {
          if (cancelled || !containerRef.current || !isRecaptchaReady() || !window.grecaptcha) return;
          if (widgetIdRef.current !== null) return;

          widgetIdRef.current = window.grecaptcha.render(widget, {
            sitekey: siteKey,
            theme,
            callback: (token: string) => { if (!cancelled) onTokenChangeRef.current(token); },
            "expired-callback": () => { if (!cancelled) onTokenChangeRef.current(""); },
            "error-callback": () => {
              if (!cancelled) { onTokenChangeRef.current(""); setStatus("error"); }
            },
          });
          setStatus("ready");
        })
        .catch(() => {
          if (!cancelled) { onTokenChangeRef.current(""); setStatus("error"); }
        });

      return () => {
        cancelled = true;
        const id = widgetIdRef.current;
        widgetIdRef.current = null;
        if (id !== null) { try { window.grecaptcha?.reset(id); } catch { /* Detached widget. */ } }
        widget.remove();
      };
    }, [siteKey, theme, attempt]);

    if (!siteKey) return null;

    return (
      <div className={`w-full pb-1 ${className}`}>
        {status === "loading" && <p role="status" className="py-3 text-center text-xs text-muted-foreground">Đang tải xác minh reCAPTCHA…</p>}
        {status === "error" && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-center text-sm">
          <p>Không tải được reCAPTCHA. Hãy kiểm tra kết nối hoặc trình chặn nội dung.</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)} className="mt-2 rounded px-2 py-1 font-semibold text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-primary">Tải lại reCAPTCHA</button>
        </div>}
        <div hidden={status !== "ready"} className="overflow-x-auto"><div ref={containerRef} className="mx-auto w-fit" /></div>
      </div>
    );
  },
);

ReCaptchaV2.displayName = "ReCaptchaV2";

export default ReCaptchaV2;
