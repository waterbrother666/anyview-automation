import importlib.util
import io
import json
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('bank_import', Path(__file__).resolve().parents[1] / 'import_bank.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        for name, value in entries:
            z.writestr(name, value)
    stream.seek(0)
    return stream


class ImportTests(unittest.TestCase):
    def test_scope(self):
        z = archive([('answers/DC01PE21.js', 'module.exports = "int example;";'),
                     ('answers/DC06PE01.js', 'module.exports = "excluded";')])
        self.assertEqual(module.import_bank(z), {'DC01PE21': 'int example;'})

    def test_no_javascript_execution(self):
        z = archive([('DC01PE21.js', 'module.exports = require("fs").readFileSync("secret");')])
        with self.assertRaises(json.JSONDecodeError):
            module.import_bank(z)

    def test_no_traversal(self):
        z = archive([('../DC01PE21.js', 'module.exports = "x";')])
        with self.assertRaises(ValueError):
            module.import_bank(z)

    def test_duplicate(self):
        z = archive([('a/DC01PE21.js', 'module.exports = "x";'), ('b/DC01PE21.js', 'module.exports = "y";')])
        with self.assertRaises(ValueError):
            module.import_bank(z)

    def test_later_chapters_require_explicit_scope(self):
        z = archive([('DC01PE21.js', 'module.exports = "a";'), ('DC06PE01.js', 'module.exports = "b";'), ('DC08PE12.js', 'module.exports = "c";')])
        self.assertEqual(module.import_bank(z, [6, 7, 8]), {'DC06PE01':'b', 'DC08PE12':'c'})

    def test_parse_chapters(self):
        self.assertEqual(module.parse_chapters('6-8'), [6,7,8])
        self.assertEqual(module.parse_chapters('1,3-5'), [1,3,4,5])
        for value in ['0','9','6,6','8-6','']:
            with self.assertRaises(ValueError): module.parse_chapters(value)


if __name__ == '__main__':
    unittest.main()
