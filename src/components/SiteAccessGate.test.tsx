import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SiteAccessGate from "./SiteAccessGate";
import { siteAccessApi, FORCE_SITE_ACCESS_EVENT } from "@/lib/api";
import * as coverCache from '@/lib/coverCache';

const session = vi.hoisted(() => ({
  user: null as null | { id: string; role: string },
  isLoggedIn: false,
  hasCheckedSession: true,
  isRestoringSession: false,
  loadUser: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("@/store/userStore", () => ({ useUserStore: () => session }));
vi.mock("@/lib/api", () => ({
  siteAccessApi: { getStatus: vi.fn() },
  FORCE_SITE_ACCESS_EVENT: "test-site-access-denied",
  setSiteAccessRestricted: vi.fn(),
}));
vi.mock("@/hooks/useCatalogUpdates", () => ({
  CatalogUpdates: () => <div data-testid="catalog-stream" />,
}));
let client: QueryClient;
beforeEach(() => {
  vi.spyOn(coverCache, 'clearCoverCache');
  session.user = null;
  session.isLoggedIn = false;
  session.hasCheckedSession = true;
  session.isRestoringSession = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});
const deny = {
  enabled: true,
  allowed: false,
  authenticated: false,
  message: "Bạn chưa được admin cấp quyền.",
};
function application(path = "/") {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SiteAccessGate>
          <div>Private reader content</div>
        </SiteAccessGate>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function show(path = "/") { return render(application(path)); }

it("blocks anonymous readers and provides a login link without mounting content or streams", async () => {
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue(deny);
  show("/chapter/private-chapter");
  expect(
    await screen.findByText("Bạn chưa được cấp quyền truy cập."),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Đăng nhập" })).toHaveAttribute(
    "href",
    "/login",
  );
  expect(screen.queryByText("Private reader content")).toBeNull();
  expect(screen.queryByTestId("catalog-stream")).toBeNull();
});

it.each(["reader", "admin"])("renders a server-approved %s", async (role) => {
  session.user = { id: role, role };
  session.isLoggedIn = true;
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({
    ...deny,
    allowed: true,
    authenticated: true,
    is_admin: role === "admin",
  });
  show();
  expect(await screen.findByText("Private reader content")).toBeInTheDocument();
  expect(screen.getByTestId("catalog-stream")).toBeInTheDocument();
});

it("opens public mode without requiring login", async () => {
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({
    ...deny,
    enabled: false,
    allowed: true,
  });
  show();
  expect(await screen.findByText("Private reader content")).toBeInTheDocument();
});

it("does not trust an old admin role after the server denies access", async () => {
  session.user = { id: "old-admin", role: "admin" };
  session.isLoggedIn = true;
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({
    ...deny,
    authenticated: true,
    is_admin: false,
  });
  show();
  expect(
    await screen.findByText("Bạn chưa được cấp quyền truy cập."),
  ).toBeInTheDocument();
  expect(screen.queryByText("Private reader content")).toBeNull();
});

it("fails closed on policy network errors while leaving login available", async () => {
  vi.mocked(siteAccessApi.getStatus).mockRejectedValue(new Error("network"));
  const view = show();
  expect(
    await screen.findByText("Chưa thể kiểm tra quyền truy cập"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Private reader content")).toBeNull();
  view.unmount();
  show("/login");
  expect(await screen.findByText("Private reader content")).toBeInTheDocument();
});

it("removes loaded reader content and cached pages immediately after revocation", async () => {
  session.user = { id: "reader", role: "reader" };
  session.isLoggedIn = true;
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({
    ...deny,
    allowed: true,
    authenticated: true,
  });
  show();
  await screen.findByText("Private reader content");
  client.setQueryData(["manga", "chapter", "secret"], {
    pages: ["secret-page"],
  });
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({
    ...deny,
    authenticated: true,
  });
  act(() => {
    window.dispatchEvent(
      new CustomEvent(FORCE_SITE_ACCESS_EVENT, { detail: deny }),
    );
  });
  await waitFor(() =>
    expect(screen.queryByText("Private reader content")).toBeNull(),
  );
  expect(client.getQueryData(["manga", "chapter", "secret"])).toBeUndefined();
  expect(coverCache.clearCoverCache).toHaveBeenCalled();
  expect(screen.queryByTestId("catalog-stream")).toBeNull();
});

it("does not render an old cached public grant before the current policy is checked", async () => {
  client.setQueryData(["site-access", "guest"], {
    ...deny,
    enabled: false,
    allowed: true,
  });
  vi.mocked(siteAccessApi.getStatus).mockImplementation(
    () => new Promise(() => {}),
  );
  show();
  expect(screen.queryByText("Private reader content")).toBeNull();
  expect(screen.queryByTestId("catalog-stream")).toBeNull();
  expect(screen.getByText("Đang kiểm tra quyền truy cập…")).toBeInTheDocument();
});

it("recovers automatically from a transient policy failure without opening content early", async () => {
  vi.mocked(siteAccessApi.getStatus).mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({ ...deny, enabled: false, allowed: true });
  show();
  expect(screen.queryByText("Private reader content")).toBeNull();
  expect(await screen.findByText("Private reader content")).toBeInTheDocument();
  expect(siteAccessApi.getStatus).toHaveBeenCalledTimes(2);
});

it("keeps an approved page and its caches through a failed background check", async () => {
  session.user = { id: "reader", role: "reader" };
  session.isLoggedIn = true;
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({ ...deny, allowed: true, authenticated: true });
  show("/manga?page=45");
  await screen.findByText("Private reader content");
  client.setQueryData(["manga", "page", 45], { items: ["cached-card"] });
  vi.mocked(coverCache.clearCoverCache).mockClear();
  vi.mocked(siteAccessApi.getStatus).mockRejectedValue(new Error("temporary network failure"));
  await act(async () => { await client.invalidateQueries({ queryKey: ["site-access"] }); });
  expect(client.getQueryState(["site-access", "reader"])?.status).toBe("error");
  expect(screen.getByText("Private reader content")).toBeInTheDocument();
  expect(client.getQueryData(["manga", "page", 45])).toEqual({ items: ["cached-card"] });
  expect(coverCache.clearCoverCache).not.toHaveBeenCalled();
  expect(screen.queryByText("Chưa thể kiểm tra quyền truy cập")).toBeNull();
});

it("closes and clears caches when an approved grant cannot be renewed for a minute", async () => {
  vi.useFakeTimers();
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({ ...deny, enabled: false, allowed: true });
  show();
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(screen.getByText("Private reader content")).toBeInTheDocument();
  client.setQueryData(["manga", "page", 45], { items: ["cached-card"] });
  vi.mocked(siteAccessApi.getStatus).mockRejectedValue(new Error("offline"));
  await act(async () => { await vi.advanceTimersByTimeAsync(55_000); });
  expect(screen.getByText("Private reader content")).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  expect(screen.queryByText("Private reader content")).toBeNull();
  expect(screen.getByText("Chưa thể kiểm tra quyền truy cập")).toBeInTheDocument();
  expect(client.getQueryData(["manga", "page", 45])).toBeUndefined();
});

it("does not use the short grant after an explicit background denial", async () => {
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({ ...deny, enabled: false, allowed: true });
  show();
  await screen.findByText("Private reader content");
  client.setQueryData(["manga", "page", 45], { items: ["cached-card"] });
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue(deny);
  await act(async () => { await client.invalidateQueries({ queryKey: ["site-access"] }); });
  await waitFor(() => expect(screen.queryByText("Private reader content")).toBeNull());
  expect(client.getQueryData(["manga", "page", 45])).toBeUndefined();
});

it("requires fresh approval after changing accounts even if that account has a cached grant", async () => {
  session.user = { id: "first-reader", role: "reader" };
  session.isLoggedIn = true;
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({ ...deny, allowed: true, authenticated: true });
  const view = show();
  await screen.findByText("Private reader content");
  client.setQueryData(["site-access", "other-reader"], { ...deny, allowed: true, authenticated: true });
  vi.mocked(siteAccessApi.getStatus).mockImplementation(() => new Promise(() => {}));
  session.user = { id: "other-reader", role: "reader" };
  view.rerender(application());
  expect(screen.queryByText("Private reader content")).toBeNull();
  expect(screen.getByText("Đang kiểm tra quyền truy cập…")).toBeInTheDocument();
});

it("offers admin recovery after a network failure while keeping reader content closed", async () => {
  session.user = { id: "admin", role: "admin" };
  session.isLoggedIn = true;
  vi.mocked(siteAccessApi.getStatus).mockRejectedValue(new Error("network"));
  const view = show();
  expect(await screen.findByRole("link", { name: "Vào trang quản trị" })).toHaveAttribute("href", "/admin");
  expect(screen.queryByText("Private reader content")).toBeNull();
  view.unmount();
  show("/admin");
  expect(await screen.findByText("Private reader content")).toBeInTheDocument();
});
