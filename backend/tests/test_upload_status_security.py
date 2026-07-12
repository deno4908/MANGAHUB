import unittest

from fastapi import HTTPException

from fastapi_app.routers.uploads import _normalize_uploader_submission_status


class UploadStatusSecurityTests(unittest.TestCase):
    def test_uploader_can_save_draft_or_submit_for_review(self):
        self.assertEqual(_normalize_uploader_submission_status("draft"), "draft")
        self.assertEqual(_normalize_uploader_submission_status(" PENDING "), "pending")
        self.assertEqual(_normalize_uploader_submission_status(None), "draft")

    def test_uploader_cannot_publish_or_reject_submission(self):
        for status in ("published", "rejected", "approved", ""):
            with self.subTest(status=status), self.assertRaises(HTTPException) as error:
                _normalize_uploader_submission_status(status)
            self.assertEqual(error.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
