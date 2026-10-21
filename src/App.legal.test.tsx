import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppRouter } from "./App";
import { authApi, getAccessToken, siteAccessApi, systemApi } from "@/lib/api";

const state = vi.hoisted(() => ({
  banLock: true,
  user: { id: "banned-user", role: "reader", isBanned: true, username: "reader" } as null | { id: string; role: string; isBanned: boolean; username: string },
  isLoggedIn: true, hasCheckedSession: true, isRestoringSession: false,
  loadUser: vi.fn().mockResolvedValue(undefined), logout: vi.fn().mockResolvedValue(undefined), fetchNotifications: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/store/userStore", () => ({ useUserStore: (select?: (value: typeof state) => unknown) => select ? select(state) : state }));
vi.mock("@/store/settingsStore", () => ({ useSettingsStore: (select: (value: unknown) => unknown) => select({ loadSettings: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("@/hooks/useCatalogUpdates", () => ({ CatalogUpdates: () => <div data-testid="catalog-stream" /> }));
vi.mock("@/lib/api", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, hasBanLock: () => state.banLock, getBanLock: () => ({ at: Date.now(), detail: "blocked" }),
    getAccessToken: vi.fn().mockReturnValue(null), authApi: { ...actual.authApi, ping: vi.fn().mockResolvedValue({}) },
    systemApi: { getMaintenance: vi.fn() }, siteAccessApi: { getStatus: vi.fn() } };
});
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.banLock = true;
  state.user = { id: "banned-user", role: "reader", isBanned: true, username: "reader" };
  state.isLoggedIn = true;
  vi.stubGlobal("scrollTo", vi.fn());
  vi.mocked(getAccessToken).mockReturnValue(null);
  vi.mocked(systemApi.getMaintenance).mockImplementation(() => new Promise(() => {}));
  vi.mocked(siteAccessApi.getStatus).mockImplementation(() => new Promise(() => {}));
});
afterEach(() => { cleanup(); client.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function Location() { return <span data-testid="path">{useLocation().pathname}</span>; }
function show(path: string) {
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Location /><Link to="/chapter/private-chapter">Test chapter navigation</Link><AppRouter /></MemoryRouter></QueryClientProvider>);
}

it.each([
  ["/privacy", "Chính sách riêng tư"],
  ["/terms", "Điều khoản sử dụng"],
  ["/privacy/?from=banned", "Chính sách riêng tư"],
])("opens %s with a banned profile and ban lock, without waiting for any API", async (path, title) => {
  show(path);
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  expect(systemApi.getMaintenance).not.toHaveBeenCalled();
  expect(siteAccessApi.getStatus).not.toHaveBeenCalled();
  expect(state.loadUser).not.toHaveBeenCalled();
  expect(screen.queryByTestId("catalog-stream")).toBeNull();
  expect(screen.getByRole("navigation", { name: "Mục lục" })).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /cskh.mangahub@gmail.com/ })[0]).toHaveAttribute("href", "mailto:cskh.mangahub@gmail.com");
});

it("allows both documents for anonymous visitors and keeps navigation between them public", async () => {
  state.user = null; state.banLock = false; state.isLoggedIn = false;
  show("/privacy");
  await screen.findByRole("heading", { level: 1, name: "Chính sách riêng tư" });
  fireEvent.click(screen.getAllByRole("link", { name: "Điều khoản sử dụng" })[0]);
  await screen.findByRole("heading", { level: 1, name: "Điều khoản sử dụng" });
  expect(screen.getByTestId("path")).toHaveTextContent("/terms");
  expect(systemApi.getMaintenance).not.toHaveBeenCalled();
  expect(siteAccessApi.getStatus).not.toHaveBeenCalled();
});

it("keeps a banned account blocked when it leaves a policy page for a chapter", async () => {
  show("/terms");
  await screen.findByRole("heading", { level: 1, name: "Điều khoản sử dụng" });
  fireEvent.click(screen.getByRole("link", { name: "Test chapter navigation" }));
  await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/banned"));
});

it("does not extend the exception to paths below a legal URL", async () => {
  show("/privacy/private-chapter");
  await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/banned"));
  expect(screen.queryByRole("heading", { level: 1, name: "Chính sách riêng tư" })).toBeNull();
});

it("does not let a pending ban check redirect away after navigating to a public document", async () => {
  state.user!.isBanned = false;
  vi.mocked(getAccessToken).mockReturnValue("test-token");
  vi.mocked(systemApi.getMaintenance).mockResolvedValue({ maintenance: { enabled: false } });
  const pending: Array<(value: unknown) => void> = [];
  vi.mocked(authApi.ping).mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
  show("/banned");
  fireEvent.click(await screen.findByRole("link", { name: "Chính sách riêng tư" }));
  await screen.findByRole("heading", { level: 1, name: "Chính sách riêng tư" });
  expect(pending.length).toBeGreaterThan(0);
  await act(async () => { pending.forEach(resolve => resolve({})); });
  expect(screen.getByTestId("path")).toHaveTextContent("/privacy");
  expect(screen.getByRole("heading", { level: 1, name: "Chính sách riêng tư" })).toBeInTheDocument();
});
