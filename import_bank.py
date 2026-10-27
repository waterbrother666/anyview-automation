"""Import a user-supplied answer archive as data, without executing JavaScript.

The imported bank and its provenance are local and excluded from Git.
"""
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

ID = re.compile(r'DC0([1-8])PE\d+[a-z]?\Z', re.I)
EXPORT = re.compile(r'module\.exports\s*=\s*(.*?);?\s*\Z', re.S)


def parse_chapters(spec):
    chapters = []
    for part in spec.split(','):
        ends = part.strip().split('-')
        if len(ends) == 1:
            chapters.append(int(ends[0]))
        elif len(ends) == 2 and int(ends[0]) <= int(ends[1]):
            chapters.extend(range(int(ends[0]), int(ends[1]) + 1))
        else:
            raise ValueError('Invalid chapter range')
    if not chapters or any(c < 1 or c > 8 for c in chapters) or len(set(chapters)) != len(chapters):
        raise ValueError('Chapters must be unique integers in 1–8')
    return sorted(chapters)


def import_bank(archive, chapters=(1,2,3,4,5)):
    bank = {}
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            path = Path(item.filename)
            if item.is_dir() or path.suffix != '.js' or not ID.fullmatch(path.stem):
                continue
            if int(ID.fullmatch(path.stem).group(1)) not in chapters:
                continue
            if '..' in path.parts or path.is_absolute() or item.file_size > 256_000:
                raise ValueError('Unsafe or oversized answer entry')
            match = EXPORT.fullmatch(z.read(item).decode('utf-8').strip())
            if not match:
                raise ValueError(f'Invalid answer export: {path.stem}')
            code = json.loads(match.group(1))
            if not isinstance(code, str) or not code.strip():
                raise ValueError(f'Answer is not a code string: {path.stem}')
            if path.stem in bank:
                raise ValueError(f'Duplicate problem ID: {path.stem}')
            bank[path.stem] = code
    if not bank:
        raise ValueError('No answers found in selected chapters')
    return bank


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--chapters', default='1-5', help='e.g. 1-5, 6-8, or 1,3')
    args = parser.parse_args()
    bank = import_bank(args.archive, parse_chapters(args.chapters))
    output = Path(__file__).resolve().parent / 'local'
    output.mkdir(exist_ok=True)
    (output / 'bank.json').write_text(json.dumps(bank, ensure_ascii=False, indent=2) + '\n')
    (output / 'provenance.json').write_text(json.dumps({
        'sha256': hashlib.sha256(args.archive.read_bytes()).hexdigest(),
        'problemCount': len(bank), 'redistributionPermission': 'not-established'
    }, indent=2) + '\n')
    print(f'Imported {len(bank)} answers into local/bank.json (excluded from Git)')
