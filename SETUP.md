# 🚀 Hướng Dẫn Setup Dự Án MangaHub

## Yêu Cầu Hệ Thống

| Công cụ | Phiên bản |
|---------|-----------|
| **Node.js** | ≥ 18 |
| **Python** | ≥ 3.10 |
| **Redis** | ≥ 7 (tuỳ chọn, cho caching & Celery) |
| **Supabase** | Tạo project miễn phí tại [supabase.com](https://supabase.com) |

---

## Bước 1: Clone & Cài đặt Frontend

```bash
cd manga-bliss-main

# Cài dependencies
npm install

# Khởi động dev server (port 8080)
npm run dev
```

Frontend chạy tại: `http://localhost:8080`

---

## Bước 2: Tạo Supabase Project

1. Vào [supabase.com](https://supabase.com) → **New Project**
2. Vào **SQL Editor** → chạy lần lượt:

```sql
-- Chạy file 1: Schema chính
-- Copy nội dung từ: backend/database/schema.sql

-- Chạy file 2: Migration bổ sung (uploads, groups, audit)
-- Copy nội dung từ: backend/database/migration_v2.sql

-- Chạy file 3: Migration manga upload
-- Copy nội dung từ: backend/database/migration_v3_manga_uploads.sql

-- Chạy file 4: Migration view tracking
-- Copy nội dung từ: backend/database/migration_v4_manga_views.sql

-- Chạy file 5: Migration chapter first-seen tracking
-- Copy nội dung từ: backend/database/migration_v5_chapter_first_seen.sql
```

3. Lấy thông tin từ **Settings → API**:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_KEY`
   - `service_role` key → `SUPABASE_SERVICE_KEY`

---

## Bước 3: Cài đặt Backend

```bash
cd backend

# Tạo virtual environment
python -m venv venv

# Kích hoạt venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
# source venv/bin/activate

# Cài dependencies
pip install -r requirements.txt
```

---

## Bước 4: Cấu hình Environment

### Backend (`backend/.env`)

```bash
# Copy từ file mẫu
copy .env.example .env
```

Sửa file `.env`:

```env
# Supabase (lấy từ Bước 2)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key

# Flask
FLASK_SECRET_KEY=thay-bang-chuoi-secret-bat-ky
FLASK_PORT=5000
FLASK_DEBUG=true

# FastAPI
FASTAPI_PORT=8000
# true = auto-reload (dev), false = cho phep da worker
FASTAPI_RELOAD=true
# 0 = auto (toi da 4 worker theo CPU), chi co tac dung khi FASTAPI_RELOAD=false
FASTAPI_WORKERS=0

# MangaDex transport (auto|curl_cffi|httpx)
MANGADEX_TRANSPORT=auto
MANGADEX_RETRIES=3
MANGADEX_TIMEOUT_SECONDS=25
MANGADEX_CONNECT_TIMEOUT_SECONDS=10
MANGADEX_RETRY_BACKOFF_SECONDS=0.35
MANGADEX_CURL_WORKERS=8
MANGADEX_CURL_IMPERSONATE=chrome131

# Redis (tuỳ chọn)
REDIS_URL=redis://localhost:6379/0

# CORS
FRONTEND_URL=http://localhost:8080

# JWT
JWT_SECRET_KEY=thay-bang-jwt-secret-bat-ky
JWT_ALGORITHM=HS256
JWT_EXPIRATION_HOURS=24
```

### Frontend (`.env` ở thư mục gốc, tuỳ chọn)

Mặc định frontend sẽ kết nối `localhost:8000` (FastAPI) và `localhost:5000` (Flask). Nếu port khác:

```env
VITE_API_URL=http://localhost:8000
VITE_AUTH_URL=http://localhost:5000
```

---

## Bước 5: Khởi động Backend

```bash
cd backend

# Chạy cả Flask + FastAPI cùng lúc
python run.py
```

Output sẽ hiện:

```
==================================================
  Manga-Bliss Backend
  Flask Gateway  → http://localhost:5000
  FastAPI Service → http://localhost:8000
  FastAPI Reload  → true/false
  FastAPI Workers → 1 (debug) hoac N (production)
  API Docs       → http://localhost:8000/docs
==================================================
```

> Lưu ý: `reload` và `workers > 1` không chạy cùng lúc trong Uvicorn.
> Muốn `FLASK_DEBUG=true` nhưng FastAPI vẫn đa worker: giữ `FLASK_DEBUG=true`, đặt `FASTAPI_RELOAD=false`, và cấu hình `FASTAPI_WORKERS` (ví dụ `4`).

---

## Bước 6: Kiểm tra

| URL | Mô tả |
|-----|-------|
| `http://localhost:8080` | Frontend |
| `http://localhost:8000/docs` | FastAPI Swagger docs |
| `http://localhost:5000/auth/me` | Flask auth API |

---

## Cấu Trúc Dự Án

```
manga-bliss-main/
├── src/                    # Frontend (React + TypeScript + Vite)
│   ├── components/         # UI components (OptimizedImage, Navbar, etc.)
│   ├── hooks/              # React Query hooks (useApi.ts)
│   ├── lib/                # API client (api.ts), adapters
│   ├── pages/              # Route pages
│   ├── store/              # Zustand stores
│   └── types/              # TypeScript types
│
├── backend/
│   ├── fastapi_app/        # FastAPI (data API, manga proxy, admin)
│   │   ├── routers/        # admin.py, uploads.py, groups.py, ...
│   │   ├── dependencies.py # Auth + RBAC
│   │   └── main.py
│   ├── flask_app/          # Flask (auth gateway)
│   │   ├── auth/routes.py  # login, register, logout, me
│   │   └── middleware.py   # JWT + role check
│   ├── database/           # SQL schemas
│   │   ├── schema.sql      # Main schema
│   │   ├── migration_v2.sql # Uploads, groups, audit
│   │   ├── migration_v3_manga_uploads.sql # Manga upload flow
│   │   └── migration_v4_manga_views.sql # Local manga views
│   │   └── migration_v5_chapter_first_seen.sql # First-seen time per chapter_id
│   ├── workers/            # Celery tasks (optional)
│   ├── config.py           # Config loader
│   ├── run.py              # Entry point
│   └── requirements.txt
│
└── package.json
```

---

## Role Hierarchy

```
admin > moderator > uploader > reader
```

| Role | Quyền |
|------|-------|
| `reader` | Đọc, comment, bookmark, follow |
| `uploader` | + Upload chapter, quản lý group |
| `moderator` | + Duyệt chapter, quản lý report |
| `admin` | + Quản lý user, ban, thay đổi role |

> **Lưu ý:** User đầu tiên đăng ký mặc định là `reader`. Để nâng role lên `admin`, chạy SQL trong Supabase:
> ```sql
> UPDATE profiles SET role = 'admin' WHERE username = 'your_username';
> ```
