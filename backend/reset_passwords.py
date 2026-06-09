"""
One-time migration script: Reset users' passwords after removing client-side hashing.

Usage:
  1. Edit DEFAULT_PASSWORD below if needed
  2. Run: python reset_passwords.py
  3. Tell affected users their temporary password
  4. Delete this file after migration
"""
from supabase import create_client
from config import config

# Temporary password for all users — they should change after login
DEFAULT_PASSWORD = "MangaHub123!"

def main():
    sb = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)

    # Get all users from auth
    users = sb.auth.admin.list_users()

    print(f"Found {len(users)} users")
    print(f"Will reset all passwords to: {DEFAULT_PASSWORD}")
    confirm = input("Continue? (y/n): ").strip().lower()

    if confirm != "y":
        print("Cancelled.")
        return

    success = 0
    failed = 0

    for user in users:
        try:
            sb.auth.admin.update_user_by_id(
                str(user.id),
                {"password": DEFAULT_PASSWORD}
            )
            print(f"  ✓ Reset: {user.email}")
            success += 1
        except Exception as e:
            print(f"  ✗ Failed: {user.email} — {e}")
            failed += 1

    print(f"\nDone! Success: {success}, Failed: {failed}")
    print(f"All users can now login with: {DEFAULT_PASSWORD}")
    print("⚠ Tell users to change their password after login!")

if __name__ == "__main__":
    main()
