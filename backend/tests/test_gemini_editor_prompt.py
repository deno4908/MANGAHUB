import unittest

from fastapi_app.services.image_editor_service import _build_gemini_manga_edit_prompt


class GeminiEditorPromptTests(unittest.TestCase):
    def test_translation_prompt_prioritizes_the_input_image(self):
        prompt = _build_gemini_manga_edit_prompt("vi", remove_only=False)

        self.assertIn("NOT generating or redesigning an image", prompt)
        self.assertIn("HIGHEST PRIORITY: preserve the exact canvas size", prompt)
        self.assertIn("Only source-text areas may be edited", prompt)
        self.assertIn("Do not infer a gender or relationship from appearance alone", prompt)
        self.assertIn("all inserted translation text must be Vietnamese only", prompt)

    def test_translation_prompt_applies_user_brief_to_wording_only(self):
        prompt = _build_gemini_manga_edit_prompt(
            "vi",
            remove_only=False,
            user_prompt="Minh xung anh, An xung em.",
        )

        self.assertIn("<user_translation_brief>", prompt)
        self.assertIn("Minh xung anh, An xung em.", prompt)
        self.assertIn("never permits changing artwork", prompt)
        self.assertIn("cannot change the target output language", prompt)

    def test_remove_only_prompt_does_not_add_translation_brief(self):
        prompt = _build_gemini_manga_edit_prompt(
            "vi",
            remove_only=True,
            user_prompt="Use anh/em.",
        )

        self.assertIn("Do not insert, translate, or replace any text", prompt)
        self.assertNotIn("user_translation_brief", prompt)


if __name__ == "__main__":
    unittest.main()
