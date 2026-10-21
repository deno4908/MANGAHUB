import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Search, UserPlus, X, Loader2 } from "lucide-react";
import { adminApi, siteAccessApi } from "@/lib/api";
import { useUserStore } from "@/store/userStore";
import { toast } from "sonner";

type Member = {
  id: string;
  username?: string;
  display_name?: string;
  email?: string;
  role?: string;
  is_banned?: boolean;
};

export default function SiteAccessSection() {
  const isAdmin = useUserStore((s) => s.user?.role === "admin");
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const policy = useQuery({
    queryKey: ["admin", "site-access"],
    queryFn: siteAccessApi.getAdmin,
    enabled: isAdmin,
  });
  const results = useQuery({
    queryKey: ["admin", "site-access-users", keyword],
    queryFn: () => adminApi.getUsers(1, keyword),
    enabled: isAdmin && !!keyword,
    retry: false,
  });
  const changed = () => {
    void client.invalidateQueries({ queryKey: ["admin", "site-access"] });
    void client.invalidateQueries({ queryKey: ["site-access"] });
  };
  const mode = useMutation({
    mutationFn: (enabled: boolean) => siteAccessApi.setMode(enabled),
    onSuccess: () => {
      changed();
      toast.success("Đã cập nhật chế độ truy cập.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const member = useMutation({
    mutationFn: ({ id, allowed }: { id: string; allowed: boolean }) =>
      siteAccessApi.setMember(id, allowed),
    onSuccess: () => {
      changed();
      toast.success("Đã cập nhật whitelist. Quyền có hiệu lực trong vài giây.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!isAdmin) return <p>Chỉ admin được quản lý quyền truy cập website.</p>;
  if (policy.isPending) return <Loader2 className="h-6 w-6 animate-spin" />;
  if (policy.isError)
    return (
      <div role="alert">
        Không tải được cấu hình.{" "}
        <button onClick={() => void policy.refetch()} className="underline">
          Thử lại
        </button>
      </div>
    );
  const members: Member[] = policy.data?.members || [];
  const ids = new Set(members.map((item) => item.id));
  return (
    <section className="space-y-6">
      <div className="rounded-2xl border border-border bg-card p-5">
        <h2 className="flex items-center gap-2 text-xl font-bold">
          <Lock className="h-5 w-5" />
          Whitelist truy cập website
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Khi bật, chỉ admin và tài khoản trong danh sách dưới đây được vào web
          và đọc truyện. Moderator, uploader và VIP cũng cần được cấp quyền.
          Admin luôn được vào.
        </p>
        <label className="mt-5 flex items-center gap-3 font-bold">
          <input
            type="checkbox"
            checked={policy.data?.enabled === true}
            disabled={mode.isPending}
            onChange={(e) => mode.mutate(e.target.checked)}
            className="h-5 w-5 accent-primary"
          />
          Chỉ cho phép admin và whitelist truy cập
        </label>
      </div>
      <div className="rounded-2xl border border-border bg-card p-5">
        <h3 className="font-bold">Cấp quyền cho tài khoản</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Tìm tài khoản đã đăng ký bằng email hoặc tên người dùng.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setKeyword(search.trim());
          }}
          className="mt-3 flex gap-2"
        >
          <input
            aria-label="Email hoặc tên người dùng"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={80}
            className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2"
            placeholder="Email hoặc tên người dùng"
          />
          <button
            disabled={!search.trim() || results.isFetching}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 font-bold text-primary-foreground"
          >
            <Search className="h-4 w-4" />
            Tìm
          </button>
        </form>
        {results.isError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            Không tìm được tài khoản. Vui lòng thử lại.
          </p>
        )}
        {keyword &&
          results.isSuccess &&
          !(results.data?.users || []).length && (
            <p className="mt-3 text-sm">Không tìm thấy tài khoản.</p>
          )}
        <ul className="mt-3 divide-y divide-border">
          {(results.data?.users || []).map((person: Member) => (
            <li
              key={person.id}
              className="flex items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-bold">
                  {person.display_name || person.username}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {person.email}
                </p>
              </div>
              <button
                disabled={
                  member.isPending ||
                  ids.has(person.id) ||
                  person.role === "admin" ||
                  person.is_banned
                }
                onClick={() => member.mutate({ id: person.id, allowed: true })}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
              >
                <UserPlus className="h-4 w-4" />
                {person.role === "admin"
                  ? "Admin"
                  : ids.has(person.id)
                    ? "Đã cấp quyền"
                    : person.is_banned
                      ? "Đã bị cấm"
                      : "Cho phép"}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-2xl border border-border bg-card p-5">
        <h3 className="font-bold">Tài khoản được phép ({members.length})</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Thu hồi sẽ chặn quyền đọc kể cả tài khoản đang đăng nhập.
        </p>
        {!members.length && (
          <p className="mt-4 text-sm text-muted-foreground">
            Chưa có tài khoản trong whitelist. Nếu bật khóa, chỉ admin được vào.
          </p>
        )}
        <ul className="mt-3 divide-y divide-border">
          {members.map((person) => (
            <li
              key={person.id}
              className="flex items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-bold">
                  {person.display_name || person.username || person.id}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {person.email}
                </p>
              </div>
              <button
                aria-label={`Thu hồi quyền của ${person.username || person.id}`}
                disabled={member.isPending}
                onClick={() => member.mutate({ id: person.id, allowed: false })}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive disabled:opacity-50"
              >
                <X className="h-4 w-4" />
                Thu hồi
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
