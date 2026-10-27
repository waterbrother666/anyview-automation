"""Build a self-contained, auditable browser snippet. No dependencies, no eval."""
import json
import argparse
from pathlib import Path

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bank', type=Path, default=root / 'local/bank.json')
args = parser.parse_args()
core = (root / 'src/core.mjs').read_text().replace('export ', '')
browser = (root / 'src/browser.js').read_text()
bank = json.loads(args.bank.read_text())
if not bank or any(not key.startswith(('DC01', 'DC02', 'DC03', 'DC04', 'DC05')) for key in bank):
    raise ValueError('Answer bank exceeds chapter scope')
browser = browser.replace('__BANK__', json.dumps(bank, ensure_ascii=False))
artifact = '// AnyView chapter 1–5 runner. See README.md before running.\n(() => {\n' + core + '\n' + browser + '\n})();\n'
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist/anyview-runner.js').write_text(artifact)
print(f'Built dist/anyview-runner.js with {len(bank)} reference solutions')
