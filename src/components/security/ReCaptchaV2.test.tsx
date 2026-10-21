import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReCaptchaV2, { type ReCaptchaV2Handle } from "./ReCaptchaV2";

beforeEach(() => { vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "public-site-key"); });
afterEach(() => {
  cleanup();
  delete window.grecaptcha;
  delete window.__mangahubRecaptchaScript;
  document.querySelectorAll('script[data-mangahub-recaptcha="true"]').forEach(script => script.remove());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("renders the widget, clears expired tokens, and resets after a form submission", async () => {
  const renderWidget = vi.fn().mockReturnValue(7), reset = vi.fn(), onTokenChange = vi.fn();
  window.grecaptcha = { render: renderWidget, reset };
  const ref = createRef<ReCaptchaV2Handle>();
  render(<ReCaptchaV2 ref={ref} onTokenChange={onTokenChange} />);
  await waitFor(() => expect(renderWidget).toHaveBeenCalledOnce());
  const callbacks = renderWidget.mock.calls[0][1];
  expect(callbacks.sitekey).toBe("public-site-key");
  act(() => callbacks.callback("solved-token"));
  expect(onTokenChange).toHaveBeenLastCalledWith("solved-token");
  act(() => callbacks["expired-callback"]());
  expect(onTokenChange).toHaveBeenLastCalledWith("");
  act(() => ref.current?.reset());
  expect(reset).toHaveBeenCalledWith(7);
  expect(onTokenChange).toHaveBeenLastCalledWith("");
});

it("shows a retry action after a failed script and can render on the next attempt", async () => {
  const onTokenChange = vi.fn();
  render(<ReCaptchaV2 onTokenChange={onTokenChange} />);
  const failedScript = document.querySelector('script[data-mangahub-recaptcha="true"]')!;
  fireEvent.error(failedScript);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(failedScript.isConnected).toBe(false);
  expect(onTokenChange).toHaveBeenLastCalledWith("");
  const renderWidget = vi.fn().mockReturnValue(8);
  window.grecaptcha = { render: renderWidget, reset: vi.fn() };
  fireEvent.click(screen.getByRole("button", { name: "Tải lại reCAPTCHA" }));
  await waitFor(() => expect(renderWidget).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alert")).toBeNull();
});

it("times out a stalled script instead of leaving the form disabled silently", async () => {
  vi.useFakeTimers();
  render(<ReCaptchaV2 onTokenChange={vi.fn()} />);
  expect(screen.getByRole("status")).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Tải lại reCAPTCHA" })).toBeEnabled();
});

it("ignores widget callbacks after the form has unmounted", async () => {
  const renderWidget = vi.fn().mockReturnValue(1), onTokenChange = vi.fn(), reset = vi.fn();
  window.grecaptcha = { render: renderWidget, reset };
  const view = render(<ReCaptchaV2 onTokenChange={onTokenChange} />);
  await waitFor(() => expect(renderWidget).toHaveBeenCalledOnce());
  const callbacks = renderWidget.mock.calls[0][1];
  view.unmount();
  onTokenChange.mockClear();
  callbacks.callback("old-token");
  callbacks["error-callback"]();
  expect(onTokenChange).not.toHaveBeenCalled();
  expect(reset).toHaveBeenCalledWith(1);
});
