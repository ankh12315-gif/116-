"""v2.5 解码规则注入回归测试（配套 verify_doc_consistency.py）：证明检查器真的会抓错，而不是「全绿即干净」。

⚠ 本测试自身也必须诚实：若某条注入抓不到，是规则漏洞，必须修规则而非改测试。
"""
import re, sys, io, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
_HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('v', os.path.join(_HERE, 'verify_doc_consistency.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

# ---- 注入样本：(说明, 文档行, 期望是否违规) ----
INJECT = [
    # (说明, 行, expect_bad)
    ('裸主张 PER_SLICE', '| 140MW 采用 PER_SLICE 编码，域逐片归一化 |', True),
    ('裸主张 GLOBAL_780', '其余 15 工况用 GLOBAL_780，域 20–800 |', True),
    ('裸主张 FIXED_780', '默认解码模式为 FIXED_780 |', True),
    ('裸主张矛盾组合', '判别式采用矛盾组合检验 |', True),
    ('裸主张逐片归一化', '编码方式为逐片归一化，域随片变化 |', True),
    ('裸主张域上限逐片', '域上限必须逐片取值 |', True),
    ('裸主张步长公式', '步长为 (dataMaxC-20)/255 |', True),
    ('保留禁令1 scaleC>100', '用 `mode = (scaleC > 100) ? SPAN : PER_LSB` 判别', True),
    ('保留禁令2 frameCount', '以 `frameCount > 500` 判别编码方式', True),
    ('保留禁令3 scaleC判据', '以 scaleC 为判据选择解码分支', True),
    # ---- 合法引用：必须放行 ----
    ('撤回清单中的 PER_SLICE', '| 2 | `HV-01-140MW` = 逐片自适应归一化 `PER_SLICE` | ❌ 作废 |', False),
    ('撤回声明', 'v2.3 / v2.4 的 PER_SLICE 结论已全部作废，不得再被引用', False),
    ('正确主张 SPAN', '其余 15 工况 `scaleMode=SPAN`，`T = 20 + (byte/255) × 780` |', False),
    ('正确主张 PER_LSB', '`HV-01-140MW` 的 `scaleMode=PER_LSB`，`T = 20 + byte × 7.843137` |', False),
    ('正确主张域2020', '`PER_LSB` 域 20–2020 ℃，步长 7.8431 ℃/LSB |', False),
    ('正确主张 7.84 步长', 'PER_LSB 步长 7.84 ℃，域 20–2020 ℃ |', False),
    ('正确主张矛盾组合被否决', '禁止用「矛盾组合检验」判别（v2.5 实测命中 0/49）', False),
    ('正确主张 逐片dataMaxC被禁', '⛔ 不得逐片取 `dataMaxC` 作为域上限', False),
    ('转换器源码引用', '`convert_v2_140mw.py` L427 写 `"scaleMode": "PER_LSB"` |', False),
    ('资产身份表', '| `HV-01-140MW` | `PER_LSB` | 49 | 10-08 14:26:16 |', False),
    ('残留 frameCount 禁令', '⛔ 不得用 `frameCount` 判别（结果不是原因）', False),
    ('证伪语境-三假说表', '| 逐片归一化 `PER_SLICE` | 仅 **38 / 667** 在容差内 | **全库否决** |', False),
    ('证伪语境-撤回清单', '| 6 | 「矛盾组合检验」是唯一正确判别式 | 命中 **0/49** | ❌ 判据本身失效 |', False),
    ('证伪语境-派生影响', '当前是 v2.4 口径（「矛盾组合判别」「逐片 `dataMaxC` 域」）', False),
    ('证伪语境-反例', 'v2.4 的 PER_SLICE 说法已被实测否决', False),
]

caught = 0
missed = []
false_pos = []
for desc, line, expect_bad in INJECT:
    doc = line + '\n'
    bad = v.check_decode_method(doc, 'INJECT')
    got = len(bad) > 0
    if expect_bad and got:
        caught += 1
        print('  ✓ 抓到  %-28s -> %s' % (desc, bad[0][:70]))
    elif expect_bad and not got:
        missed.append((desc, line))
        print('  ✗ 漏过  %-28s :: %s' % (desc, line[:60]))
    elif (not expect_bad) and got:
        false_pos.append((desc, line, bad[0]))
        print('  ✗ 假阳性 %-27s -> %s' % (desc, bad[0][:70]))
    else:
        print('  · 放行  %-28s' % desc)

print()
print('=' * 70)

# ---- v2.6：check_slice_frames 合法引用豁免的边界回归 ----
#背景：v2.6 给附录 D 写「可复现检测命令」时，命令本身含被禁字面量
#   （grep -n '101 帧' ...），触发误报。已加 selfcheck 豁免，此处锁定其边界：
#   放过检测命令，但**真实硬编码必须仍被抓到**（豁免不得成为万能出口）。
print()
print('=== check_slice_frames 豁免边界回归（合法引用 vs 真实违规）===')
FRAME_CASES = [
    # ── A组：原始 8 例（v2.6首版，锁定基础行为）──
    ('违规:硬编码 101 帧',      True,  '加载进度分母固定为 101 帧'),
    ('违规:/101 路径',          True,  '见 docs/101 页'),
    ('违规:单片体积字面量',      True,  '单片 25 856 B'),
    ('违规:Δt 字面量',         True,  'Δt ≈ 18.00 s 帧间隔'),
    ('合法:grep 检测命令',      False, "grep -n '101 帧' src/ui/StatusBar.tsx"),
    ('合法:sed 检测命令',       False, "sed -n '218,235p' src/utils/coords.ts | grep -c /101"),
    ('合法:注释式检测命令',      False, '# grep -n 101帧 scripts/x.py'),
    ('合法:已有禁令限定',        False, '⛔ 硬编码 101 帧'),
    # ── B 组：visual-designer 注入的「命令 + 违规断言」混合形态 ──
    #   背景：首版selfcheck 只看「是不是命令」，不看「是不是只有命令」，
    #   命令后再跟一句违规断言照样豁免 → 万能出口。9 例仅抓到 3。
    ('违规:命令+中文断言',      True,  "grep -n '101 帧' docs/x.md 加载分母写死 101 帧"),
    ('违规:node+中文断言',      True,  'node scripts/a.js —— 101 帧应改为动态读取'),
    ('违规:awk+中文断言',True,  "awk '{print}' src/a.txt 其中 Δt ≈ 18.00 是错的"),
    ('违规:rg+硬编码帧数',      True,  "rg '101' src/ui/App.tsx 硬编码帧数 101"),
    # ── C 组：ux-designer 补充的**英文散文**变体 ──
    #   背景：收紧版 tail_bad 靠 CJK 码位判「是否散文」，纯英文直接绕过。
    ('违规:英文第二断言',        True,  'node scripts/a.js -- 101 frames is wrong and must be dynamic'),
    ('违规:英文单位裸数字',     True,  'the slice buffer is 101 frames long'),
    ('违规:帧数反序',          True,  '加载分母设成帧数 101'),
    # ── D 组：弱豁免词**自我豁免**形态（visual-designer 发现）──
    #   背景：`硬编码`/`动态`/`实测`/`逐工况` 是裸子串，在禁令句合法、
    #   在主张句违规。行级「含词即豁免」无法区分 —— 与 check_decode_method
    #   里 `溢出` 同类。修法：弱词须有禁令标记或结构性标记支撑才豁免。
    #   回归意义：防止有人日后把弱词挪回 allow_kw 而无声退化。
    ('违规:弱词硬编码',         True,  "rg '101' src/ui/App.tsx 硬编码帧数 101"),
    ('违规:弱词动态',          True,  'node scripts/a.js —— 101 帧应改为动态读取'),
    ('违规:弱词实测+帧数',      True,  'Δt ≈ 18.00 s 写死了，应逐工况动态取值'),
    # ── E 组：合法引用（收紧后**必须仍放行**，否则误报）──
    ('合法:禁令句 Δt',False, '⛔ 不得写死 Δt ≈ 18.00'),
    ('合法:分母说明',        False, '101 帧分母会让 140MW 进度停在 4.3%'),
    ('合法:RGB 色标锚点',     False, 'rgb(101, 37, 87)'),
    ('合法:实测基线表',      False, '其余 15 工况为 101 帧 / 18.00 s / 25 856 B'),
]
# ⚠ 已知不可判定边界（v2.6 三修实测后**主动不抓**，抓则假阳性 > 收益）：
#   这三类**确实是真实违规**，但故意不抓。判据是「能否无歧义判定」：
#   ① 纯裸数字 `grep -n 101 src/… at 101`
#      抓它须把裸 \b101\b 纳入 lit_re，但全库有 **19 行**合法命中
#      （禁令句 DS L420 / 基线表 UX L491、DS L417 / 进度示例 L494 /
#        **色标锚点 rgb(101, 37, 87)**），每条都要靠 allow_kw 逐行豁免。
#   ② 无前缀 Δt `18.00 s 是错的`  —— 同上，须纳入裸 \b18\.00\b。
#   ③ 无帧语义散文 `这里 18.00 是错的` —— `18.00` 紧跟中文「是错的」，
#      既可能是帧间隔也可能是压力量/时间常数，正则无法区分语义。
#   ⇒ **本检查器只覆盖带「帧 / 时间步 / 字节体积」语义单位的形态。**
#     裸数字的语义归属需上下文理解，超出正则可判定范围；
#     人工评审按 UX_SPEC 附录 D.3 逐条核对，不依赖本检查器兜底。
#     ⚠ 这三条**不是「已知洞」而是「已知取舍」** —— 故不断言必须抓到，
#       只断言「当前仍未抓到」，一旦规则变更即报警复测。
KNOWN_GAP = [
    ('裸数字英文散文', 'grep -n 101 src/utils/coords.ts denominator is hardcoded at 101'),
    ('无前缀 Δt 主张', '18.00 s 是错的，应逐工况实测得到'),
    ('无帧语义散文',   '# grep src/a.py 这里 18.00 是错的'),
]
frame_bad = []
for desc, expect_bad, line in FRAME_CASES:
    bad = v.check_slice_frames(line + '\n', 'INJECT')
    got = len(bad) > 0
    if got != expect_bad:
        frame_bad.append((desc, line, bad))
    print('  %s %-24s 期望抓=%-5s 实抓=%-5s' % (
        '✓' if got == expect_bad else '✗', desc, expect_bad, got))
if frame_bad:
    print('  ⛔ 豁免边界失守：')
    for d, l, b in frame_bad:
        print('     -', d, '::', l[:60], '=>', (b[0][:70] if b else '(漏过)'))
else:
    _exp_bad = sum(1 for x in FRAME_CASES if x[1])
    print('  ✓ %d/%d 符合预期：%d 条真实违规全抓，%d 条合法引用全放行'
          % (len(FRAME_CASES), len(FRAME_CASES), _exp_bad,
             len(FRAME_CASES) - _exp_bad))
    print('  ⚠ 已知不可判定边界 %d 条（主动不抓，见 KNOWN_GAP 注释）：'
          % len(KNOWN_GAP))
    for gname, g in KNOWN_GAP:
        got_gap = len(v.check_slice_frames(g + '\n', 'INJECT')) > 0
        assert not got_gap, (
            'KNOWN_GAP「%s」已被抓到 —— 说明规则放宽了，'
            '须复测 19 行合法命中是否变假阳性' % gname)
        print('     · %-16s %s' % (gname, g[:52]))
print('=' * 70)
print('应抓 %d / 实抓 %d ; 假阳性 %d' % (
    sum(1 for x in INJECT if x[2]), caught, len(false_pos)))
if missed:
    print('漏过：')
    for d, l in missed:
        print('   -', d, '::', l[:70])
if false_pos:
    print('假阳性：')
    for d, l, b in false_pos:
        print('   -', d, '::', l[:60], '=>', b[:70])
print('=' * 70)

# ---- 资产级断言的反向测试：篡改一个 .bin 看是否被抓 ----
print()
print('=== 资产级断言反向测试（故意破坏判别式，看是否抓到）===')
orig = v.check_asset_decode
res = orig()
print('正常资产：%d 处问题（应为 0）' % len(res))
if res:
    for r in res[:5]:
        print('   ', r)
sys.exit(0 if (not missed and not false_pos and not res and not frame_bad) else 1)
