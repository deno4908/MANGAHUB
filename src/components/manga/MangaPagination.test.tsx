import { fireEvent, render, screen } from "@testing-library/react";
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
});
