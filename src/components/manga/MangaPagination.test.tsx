import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MangaPagination from "./MangaPagination";

describe("MangaPagination", () => {
  it("jumps to the requested page without changing the surrounding filters", () => {
    const onPageChange = vi.fn();
    render(<MangaPagination currentPage={3} totalPages={20} onPageChange={onPageChange} />);

    const input = screen.getByRole("textbox", { name: "Đến trang, từ 1 đến 20" });
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.submit(input.closest("form")!);

    expect(onPageChange).toHaveBeenCalledWith(12);
  });

  it("clamps a requested page to the available range", () => {
    const onPageChange = vi.fn();
    render(<MangaPagination currentPage={3} totalPages={20} onPageChange={onPageChange} />);

    const input = screen.getByRole("textbox", { name: "Đến trang, từ 1 đến 20" });
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.submit(input.closest("form")!);

    expect(onPageChange).toHaveBeenCalledWith(20);
  });

  it("warms only a deliberate page intent and cancels cursor sweeps and unmounted intents", () => {
    vi.useFakeTimers();
    try {
      const onPageIntent = vi.fn(), onPageChange = vi.fn();
      const view = render(<MangaPagination currentPage={3} totalPages={20} onPageChange={onPageChange} onPageIntent={onPageIntent} />);
      const next = screen.getByRole("button", { name: "Trang sau" });
      expect(onPageIntent).not.toHaveBeenCalled();
      fireEvent.pointerEnter(next);
      act(() => { vi.advanceTimersByTime(100); });
      fireEvent.pointerLeave(next);
      act(() => { vi.advanceTimersByTime(200); });
      expect(onPageIntent).not.toHaveBeenCalled();
      fireEvent.focus(next);
      act(() => { vi.advanceTimersByTime(150); });
      expect(onPageIntent).toHaveBeenCalledExactlyOnceWith(4);
      expect(onPageChange).not.toHaveBeenCalled();
      fireEvent.pointerEnter(screen.getByRole("button", { name: "Trang 2" }));
      view.unmount();
      act(() => { vi.advanceTimersByTime(200); });
      expect(onPageIntent).toHaveBeenCalledTimes(1);
    } finally { cleanup(); vi.useRealTimers(); }
  });
});
