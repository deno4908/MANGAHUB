"""Reading workers should not eagerly load the upload studio's native libraries."""
import subprocess
import sys
from pathlib import Path


def test_importing_editor_keeps_native_libraries_unloaded():
    code = '''
import sys
from fastapi_app.services import image_editor_service as editor
assert 'cv2' not in sys.modules
assert 'numpy' not in sys.modules
assert editor._build_gemini_manga_edit_prompt('vi', remove_only=False)
assert 'cv2' not in sys.modules
assert 'numpy' not in sys.modules
'''
    subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).resolve().parents[1], check=True,
                   capture_output=True, text=True, timeout=30)


def test_native_editor_operations_still_work_when_first_used():
    import io
    from PIL import Image
    from fastapi_app.services import image_editor_service as editor

    image = io.BytesIO()
    Image.new('RGB', (8, 6), 'white').save(image, format='PNG')
    decoded = editor._decode_image(image.getvalue())
    assert decoded.shape == (6, 8, 3)
    assert editor._to_data_url(decoded).startswith('data:image/png;base64,')
