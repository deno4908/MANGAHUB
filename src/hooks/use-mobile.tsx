import * as React from "react";

const MOBILE_BREAKPOINT = 768;

function detectMobileDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const mobileUserAgent = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const touchDevice =
    navigator.maxTouchPoints > 0 &&
    (window.matchMedia("(pointer: coarse)").matches ||
      window.matchMedia("(hover: none)").matches);
  return window.innerWidth < MOBILE_BREAKPOINT || mobileUserAgent || touchDevice;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(detectMobileDevice);

  React.useEffect(() => {
    const widthQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");
    const noHoverQuery = window.matchMedia("(hover: none)");
    const onChange = () => {
      setIsMobile(detectMobileDevice());
    };
    widthQuery.addEventListener("change", onChange);
    coarsePointerQuery.addEventListener("change", onChange);
    noHoverQuery.addEventListener("change", onChange);
    window.addEventListener("orientationchange", onChange);
    onChange();
    return () => {
      widthQuery.removeEventListener("change", onChange);
      coarsePointerQuery.removeEventListener("change", onChange);
      noHoverQuery.removeEventListener("change", onChange);
      window.removeEventListener("orientationchange", onChange);
    };
  }, []);

  return isMobile;
}
