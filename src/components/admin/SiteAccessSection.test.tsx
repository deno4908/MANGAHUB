import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SiteAccessSection from "./SiteAccessSection";
import { adminApi, siteAccessApi } from "@/lib/api";

const session = vi.hoisted(() => ({ user: { role: "admin" } }));
vi.mock("@/store/userStore", () => ({
  useUserStore: (selector: (value: typeof session) => unknown) =>
    selector(session),
}));
vi.mock("@/lib/api", () => ({
  adminApi: { getUsers: vi.fn() },
  siteAccessApi: { getAdmin: vi.fn(), setMode: vi.fn(), setMember: vi.fn() },
}));
let client: QueryClient;
beforeEach(() => {
  session.user.role = "admin";
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(siteAccessApi.getAdmin).mockResolvedValue({
    enabled: false,
    message: "Whitelist",
    members: [],
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.clearAllMocks();
});
function show() {
  return render(
    <QueryClientProvider client={client}>
      <SiteAccessSection />
    </QueryClientProvider>,
  );
}

it("lets an admin enable the lock and grant then revoke a registered reader", async () => {
  const person = {
    id: "22222222-2222-4222-8222-222222222222",
    username: "reader",
    email: "reader@example.test",
    role: "reader",
  };
  vi.mocked(adminApi.getUsers).mockResolvedValue({ users: [person] });
  vi.mocked(siteAccessApi.setMode).mockResolvedValue({ enabled: true });
  vi.mocked(siteAccessApi.setMember).mockResolvedValue({});
  show();
  const toggle = await screen.findByRole("checkbox");
  vi.mocked(siteAccessApi.getAdmin).mockResolvedValue({
    enabled: true,
    message: "Whitelist",
    members: [],
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(siteAccessApi.setMode).toHaveBeenCalledWith(true));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: person.email },
  });
  fireEvent.click(screen.getByRole("button", { name: "Tìm" }));
  await waitFor(() =>
    expect(adminApi.getUsers).toHaveBeenCalledWith(1, person.email),
  );
  vi.mocked(siteAccessApi.getAdmin).mockResolvedValue({
    enabled: true,
    message: "Whitelist",
    members: [person],
  });
  fireEvent.click(await screen.findByRole("button", { name: "Cho phép" }));
  await waitFor(() =>
    expect(siteAccessApi.setMember).toHaveBeenCalledWith(person.id, true),
  );
  const revoke = await screen.findByRole("button", {
    name: "Thu hồi quyền của reader",
  });
  vi.mocked(siteAccessApi.getAdmin).mockResolvedValue({
    enabled: true,
    message: "Whitelist",
    members: [],
  });
  fireEvent.click(revoke);
  await waitFor(() =>
    expect(siteAccessApi.setMember).toHaveBeenCalledWith(person.id, false),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Thu hồi quyền của reader" }),
    ).toBeNull(),
  );
});

it("does not show whitelist controls to a moderator", () => {
  session.user.role = "moderator";
  show();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(siteAccessApi.getAdmin).not.toHaveBeenCalled();
});
