# MangaHub — Đọc Truyện Tranh Online

Web application đọc truyện tranh miễn phí, xây dựng trên Vite + React + TypeScript.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Framer Motion, Zustand, React Query, Sonner
- **Backend**: FastAPI (data API), Flask (auth), Supabase (database + storage)
- **Styling**: Vanilla CSS + CSS variables (dark/light theme)

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

## Data Flow Documentation

- Full end-to-end data-flow guide (frontend, API, DB, storage, external services): `README_DATA_FLOW.md`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | FastAPI backend URL (default: `http://localhost:8000`) |
| `VITE_AUTH_URL` | Flask auth service URL (default: `http://localhost:5000`) |

## Project Structure

```
src/
├── components/   # Reusable UI components
├── hooks/        # Custom React hooks (useApi, etc.)
├── lib/          # API client, adapters, utils
├── pages/        # Route pages
├── store/        # Zustand stores
├── types/        # TypeScript types
└── main.tsx      # App entry point

backend/
├── fastapi_app/  # FastAPI data API
├── flask_app/    # Flask auth service
└── database/     # Supabase schema + migrations
```

## Features

- 📖 Browse, search, and read manga chapters
- 🔖 Bookmarks & follow system
- 🕓 Reading history with progress tracking
- 💬 Comment system with reactions
- 🛡️ Role-based access control (admin, moderator, uploader, reader)
- 📊 Admin panel with user management, analytics, and content moderation
- 🖼️ Optimized image loading (IntersectionObserver + progressive reveal + auto-retry)
