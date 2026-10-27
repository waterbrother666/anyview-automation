"""Build a self-contained, auditable browser snippet. No dependencies, no eval."""
import json
import argparse
import html
import urllib.parse
from pathlib import Path
from import_bank import ID, parse_chapters

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bank', type=Path, default=root / 'local/bank.json')
parser.add_argument('--chapters', default='1-5', help='Explicit chapter scope, e.g. 6-8')
args = parser.parse_args()
chapters = parse_chapters(args.chapters)
core = (root / 'src/core.mjs').read_text().replace('export ', '')
browser = (root / 'src/browser.js').read_text()
bank = json.loads(args.bank.read_text())
if not isinstance(bank, dict) or any(not ID.fullmatch(key) or not isinstance(value, str) for key,value in bank.items()):
    raise ValueError('Invalid answer bank')
bank = {key:value for key,value in bank.items() if int(ID.fullmatch(key).group(1)) in chapters}
if not bank:
    raise ValueError('No answers in selected chapter scope')
browser = browser.replace('__BANK__', json.dumps(bank, ensure_ascii=False))
browser = browser.replace('__CHAPTERS__', json.dumps(chapters))
artifact = '// AnyView scoped runner. See README.md before running.\n(() => {\n' + core + '\n' + browser + '\n})();\n'
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist/anyview-runner.js').write_text(artifact)
bookmark = 'javascript:' + urllib.parse.quote(artifact, safe='')
scope_label = '第' + '、'.join(map(str, chapters)) + '章'
installer = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>AnyView 本地启动器</title><h1>AnyView 本地启动器</h1>
<p>这是本地生成的启动器，包含你自行导入的题解，不要公开上传。</p>
<ol><li>将下面的「AnyView 自动过题」链接拖到 Ego Lite 书签栏。</li>
<li>切回已登录的 AnyView 学生题目页，点击刚添加的书签。</li>
<li>看到控制面板后，在学校原页面点击一次返回或章节，再点击「读取课程与目录」。</li></ol>
<p><a draggable="true" href="''' + html.escape(bookmark, quote=True) + '''">AnyView 自动过题 ''' + scope_label + '''</a></p>
<p>点击书签会在 AnyView 官方学生页加载已审阅的本地脚本；脚本不会另行登录，
也不会自动开始判题。面板里先验证一题，再开始所选章节。
通过状态必须由判题响应和服务端目录共同确认。</p>
<p>如果浏览器显示粘贴、权限或安全提示，请由用户本人处理。</p></html>'''
(root / 'dist/install.html').write_text(installer)
print(f'Built dist/anyview-runner.js with {len(bank)} reference solutions')
