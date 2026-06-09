"""
Pydantic schemas for API request/response validation.
"""

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


# ============================================================
# Enums
# ============================================================
class UserRole(str, Enum):
    reader = "reader"
    uploader = "uploader"
    moderator = "moderator"
    admin = "admin"


class ReportType(str, Enum):
    manga = "manga"
    chapter = "chapter"
    comment = "comment"
    user = "user"
    bug = "bug"
    account = "account"
    content = "content"
    missing_pages = "missing_pages"
    wrong_order = "wrong_order"
    wrong_chapter = "wrong_chapter"
    translation = "translation"
    other = "other"


class ReportStatus(str, Enum):
    pending = "pending"
    reviewing = "reviewing"
    resolved = "resolved"
    dismissed = "dismissed"


class NotificationType(str, Enum):
    new_chapter = "new_chapter"
    reply = "reply"
    system = "system"
    follow_update = "follow_update"


class ReadingMode(str, Enum):
    vertical = "vertical"
    horizontal = "horizontal"
    webtoon = "webtoon"


# ============================================================
# User Schemas
# ============================================================
class ProfileUpdate(BaseModel):
    display_name: Optional[str] = None
    bio: Optional[str] = None
    avatar: Optional[str] = None
    name_color: Optional[str] = None
    name_font: Optional[str] = None
    name_effect: Optional[str] = None


class ProfileResponse(BaseModel):
    id: str
    username: str
    display_name: str
    email: Optional[str] = None
    avatar: str = ""
    bio: str = ""
    role: str = "reader"
    is_vip: bool = False
    vip_expiry: Optional[str] = None
    name_color: Optional[str] = None
    name_font: Optional[str] = None
    name_effect: Optional[str] = None
    chapters_read: int = 0
    total_reading_time: int = 0
    comments_posted: int = 0
    reading_streak: int = 0
    created_at: Optional[str] = None


class SettingsUpdate(BaseModel):
    # Reader
    reading_mode: Optional[str] = None
    page_direction: Optional[str] = None
    image_fit: Optional[str] = None
    image_loading: Optional[str] = None
    auto_hide_toolbar: Optional[bool] = None
    show_page_number: Optional[bool] = None
    show_progress_bar: Optional[bool] = None
    auto_bookmark: Optional[bool] = None
    auto_follow: Optional[bool] = None
    # Notifications
    notify_new_chapter: Optional[bool] = None
    notify_comment_reply: Optional[bool] = None
    notify_system: Optional[bool] = None
    notify_email: Optional[bool] = None
    # Privacy
    profile_visibility: Optional[str] = None
    show_reading_history: Optional[bool] = None
    show_followed_manga: Optional[bool] = None
    show_comments: Optional[bool] = None
    show_mature_content: Optional[bool] = None


# ============================================================
# Bookmark/Follow Schemas
# ============================================================
class MangaAction(BaseModel):
    """Used for bookmark/follow/unfollow."""

    manga_slug: str
    manga_title: str = ""
    manga_thumb: str = ""


# ============================================================
# Reading History Schemas
# ============================================================
class HistoryEntry(BaseModel):
    manga_slug: str
    manga_title: str = ""
    manga_thumb: str = ""
    chapter_id: str
    chapter_name: str = ""
    page: int = 0
    progress: float = 0


# ============================================================
# Comment Schemas
# ============================================================
class CommentCreate(BaseModel):
    manga_slug: str
    chapter_id: Optional[str] = None
    parent_id: Optional[str] = None
    content: str = Field("", max_length=2000)
    image_url: Optional[str] = None


class CommentUpdate(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)


class CommentResponse(BaseModel):
    id: str
    user_id: str
    username: str = ""
    avatar: str = ""
    role: Optional[str] = None
    manga_slug: str
    chapter_id: Optional[str] = None
    parent_id: Optional[str] = None
    content: str
    image_url: Optional[str] = None
    likes: int = 0
    reactions: dict = {}
    created_at: Optional[str] = None
    replies: List["CommentResponse"] = []


# ============================================================
# Notification Schemas
# ============================================================
class NotificationResponse(BaseModel):
    id: str
    type: str
    title: str
    message: str
    manga_slug: Optional[str] = None
    chapter_id: Optional[str] = None
    is_read: bool = False
    created_at: Optional[str] = None


# ============================================================
# Report Schemas
# ============================================================
class ReportCreate(BaseModel):
    report_type: ReportType
    target_id: Optional[str] = None
    title: str = Field(..., min_length=1, max_length=255)
    description: str = Field(..., min_length=1, max_length=5000)
    recaptcha_token: Optional[str] = Field(default=None, max_length=4096)


# ============================================================
# Rating Schemas
# ============================================================
class RatingCreate(BaseModel):
    manga_slug: str
    score: float = Field(..., ge=1, le=5)


# ============================================================
# Admin Schemas
# ============================================================
class BanUser(BaseModel):
    user_id: str
    ban_reason: str = ""


class ChangeRole(BaseModel):
    user_id: str
    role: UserRole


class NotifyRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=2000)
    target: str = "all"  # "all", "reader", "uploader", "moderator", "admin"
    notify_type: str = "system"  # maps to notification type
    announcement_type: Optional[str] = "system"  # "system", "maintenance", "event", "warning"
    show_popup: Optional[bool] = False
    popup_expires_hours: Optional[int] = Field(default=24, ge=1, le=720)
    image_url: Optional[str] = Field(default=None, max_length=1000)
    cta_label: Optional[str] = Field(default=None, max_length=80)
    cta_url: Optional[str] = Field(default=None, max_length=1000)
    popup_size: Optional[str] = "standard"  # "compact", "standard", "wide"
    popup_dismissible: Optional[bool] = True
    priority: Optional[int] = Field(default=0, ge=0, le=1000)


class VipUpdate(BaseModel):
    is_vip: bool
    vip_expiry: Optional[str] = None  # ISO datetime string or None
