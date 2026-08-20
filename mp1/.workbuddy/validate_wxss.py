from pathlib import Path

files = [
    Path('c:/Users/Administrator/Desktop/小程序/mp1/app.wxss'),
    Path('c:/Users/Administrator/Desktop/小程序/mp1/pages/index/index.wxss'),
    Path('c:/Users/Administrator/Desktop/小程序/mp1/pages/portfolio/portfolio.wxss'),
    Path('c:/Users/Administrator/Desktop/小程序/mp1/pages/setting/setting.wxss'),
    Path('c:/Users/Administrator/Desktop/小程序/mp1/pages/analysis/analysis.wxss'),
    Path('c:/Users/Administrator/Desktop/小程序/mp1/pages/fund/fund.wxss'),
    Path('c:/Users/Administrator/Desktop/小程序/mp1/components/fundDetail/fundDetail.wxss'),
]

for p in files:
    text = p.read_text(encoding='utf-8')
    depth = 0
    i = 0
    n = len(text)
    in_str = None
    ok = True
    while i < n:
        c = text[i]
        if in_str:
            if c == in_str and text[i-1] != '\\':
                in_str = None
            i += 1
            continue
        if c in '"\'':
            in_str = c
            i += 1
            continue
        if c == '/' and i+1 < n and text[i+1] == '*':
            j = text.find('*/', i+2)
            if j == -1:
                ok = False
                break
            i = j + 2
            continue
        if c == '/' and i+1 < n and text[i+1] == '/':
            i = text.find('\n', i)
            if i == -1:
                break
            i += 1
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth < 0:
                ok = False
                break
        i += 1
    if ok and depth == 0:
        print(f'{p.name} OK')
    else:
        print(f'{p.name} FAIL depth={depth}')
