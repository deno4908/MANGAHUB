import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

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

function waitForRecaptchaReady(timeoutMs = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      if (isRecaptchaReady()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("reCAPTCHA API did not become ready"));
        return;
      }
      window.setTimeout(check, 50);
    };

    check();
  });
}

function loadRecaptchaScript() {
  if (isRecaptchaReady()) return Promise.resolve();
  if (window.__mangahubRecaptchaScript) return window.__mangahubRecaptchaScript;

  window.__mangahubRecaptchaScript = new Promise<void>((resolve, reject) => {
    const resolveWhenReady = () => {
      waitForRecaptchaReady().then(resolve).catch(reject);
    };
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-mangahub-recaptcha="true"]',
    );
    if (existing) {
      existing.addEventListener("load", resolveWhenReady, { once: true });
      existing.addEventListener("error", () => reject(new Error("reCAPTCHA load failed")), {
        once: true,
      });
      resolveWhenReady();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://www.google.com/recaptcha/api.js?render=explicit&hl=vi";
    script.async = true;
    script.defer = true;
    script.dataset.mangahubRecaptcha = "true";
    script.onload = resolveWhenReady;
    script.onerror = () => reject(new Error("reCAPTCHA load failed"));
    document.head.appendChild(script);
  }).catch((error) => {
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

    onTokenChangeRef.current = onTokenChange;

    const reset = () => {
      if (widgetIdRef.current !== null && window.grecaptcha) {
        window.grecaptcha.reset(widgetIdRef.current);
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
      loadRecaptchaScript()
        .then(() => {
          if (cancelled || !containerRef.current || !isRecaptchaReady() || !window.grecaptcha) return;
          if (widgetIdRef.current !== null) return;

          widgetIdRef.current = window.grecaptcha.render(containerRef.current, {
            sitekey: siteKey,
            theme,
            callback: (token: string) => onTokenChangeRef.current(token),
            "expired-callback": () => onTokenChangeRef.current(""),
            "error-callback": () => onTokenChangeRef.current(""),
          });
        })
        .catch(() => {
          if (!cancelled) onTokenChangeRef.current("");
        });

      return () => {
        cancelled = true;
      };
    }, [siteKey, theme]);

    if (!siteKey) return null;

    return (
      <div className={`flex w-full justify-center overflow-x-auto pb-1 ${className}`}>
        <div ref={containerRef} className="inline-block" />
      </div>
    );
  },
);

ReCaptchaV2.displayName = "ReCaptchaV2";

export default ReCaptchaV2;
