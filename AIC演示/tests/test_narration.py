import array
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('narration', ROOT / 'scripts/synthesize-narration.py')
narration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(narration)


class NarrationTests(unittest.TestCase):
    def test_ssml_escapes_text(self):
        result = narration.make_ssml('A & B < C', 'zh-CN-YunyangNeural').decode()
        self.assertIn('A &amp; B &lt; C', result)
        with self.assertRaises(ValueError):
            narration.make_ssml('text', 'untrusted" voice')

    def test_refuses_credential_redirect(self):
        self.assertIsNone(narration.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.com'))

    def test_destination_validation_before_network(self):
        with patch('urllib.request.build_opener') as opener:
            for region, resource in [('eastus.example.com', 'v1'), ('eastus', '../evil')]:
                with self.assertRaises(ValueError):
                    narration.request_azure(region, 'test-only', resource)
            opener.assert_not_called()

    def test_http_error_does_not_expose_response_or_key(self):
        failure = urllib.error.HTTPError('https://example.invalid', 401, 'secret-body', {}, None)
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect = failure
            with self.assertRaisesRegex(RuntimeError, r'^Azure Speech HTTP 401; stopped$'):
                narration.request_azure('eastus', 'test-only', 'voices/list')
            self.assertEqual(opener.return_value.open.call_count, 1)

    def test_pcm_roundtrip_and_trim(self):
        pcm = array.array('h', [0]) * 2400 + array.array('h', [1000, -1000]) * 2400 + array.array('h', [0]) * 2400
        trimmed = narration.trim_silence(pcm)
        self.assertLess(len(trimmed), len(pcm))
        self.assertGreaterEqual(len(trimmed), 4800)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'audio.wav'
            narration.write_pcm(path, trimmed)
            self.assertEqual(narration.read_pcm(path), trimmed)
        with self.assertRaisesRegex(ValueError, 'silent'):
            narration.trim_silence(array.array('h', [0]) * 2400)

    def test_slots_follow_actual_module_pages(self):
        chapters = []
        cards = []
        for i in range(12):
            chapters.append({'key': str(i), 'module': str(i), 'intro': '引入', 'narration': '正文'})
            cards.append({'module': str(i), 'start': i * 20., 'end': i * 20. + 7})
        result = narration.build_segments({'chapters': chapters}, {'module_pages': cards, 'duration': 240})
        self.assertEqual(len(result), 24)
        self.assertEqual(result[1]['start'], 7.3)
        for a, b in zip(result, result[1:]):
            self.assertLessEqual(a['slot_end'], b['start'])
        cards[1]['module'] = 'mismatch'
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            narration.build_segments({'chapters': chapters}, {'module_pages': cards, 'duration': 240})


if __name__ == '__main__':
    unittest.main()
