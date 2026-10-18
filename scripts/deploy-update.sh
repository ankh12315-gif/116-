#!/usr/bin/env bash
# 116 配电室 FDS 站点 —— 一键增量更新（精简版，功能完整）
# 红线：1) 绝不碰 public/assets  2) 绝不 reset --hard/clean -fd
#       3) 必备份+可回滚  4) 保留 *.log 与 .env  5) 暂存构建+原子换名
set -uo pipefail
APP=/opt/fire-116; BR=main; BK=/opt/fire-backups; SVC=fire116
PROT="public/assets"; STAGE="$APP/dist.__stage__"
export PATH=/usr/local/bin:$PATH
cd "$APP" || { echo "找不到 $APP"; exit 1; }
git config --global --add safe.directory "$APP" 2>/dev/null
TS="$(date -u +%Y%m%d-%H%M%S)"; BD="$BK/upd-$TS"
ok(){ echo -e "\033[32m$*\033[0m"; }; bad(){ echo -e "\033[31m$*\033[0m"; }
warn(){ echo -e "\033[33m$*\033[0m"; }; step(){ echo -e "\n\033[36m== $* ==\033[0m"; }
die(){ bad "✗ $*"; exit 1; }
fp(){ find "$PROT" -type f -printf '%s %p\n' 2>/dev/null | LC_ALL=C sort | md5sum | cut -d' ' -f1; }
fc(){ find "$PROT" -type f 2>/dev/null | wc -l; }
healthy(){ local a b; a=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:5184/ 2>/dev/null||echo 0); b=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:5184/api/setup 2>/dev/null||echo 0); [ "$a" = 200 ]&&[ "$b" = 200 ]; }
wait_h(){ local n=$1 i; for((i=0;i<n;i++)); do healthy&&return 0; sleep 2; done; return 1; }
rollback(){ bad "更新失败: $1 → 自动回滚"
  [ -d "$BD/dist" ]&&{ rm -rf "$APP/dist.__bad__"; [ -d "$APP/dist" ]&&mv "$APP/dist" "$APP/dist.__bad__"; mv "$BD/dist" "$APP/dist"; rm -rf "$APP/dist.__bad__"; }
  if [ -f "$BD/code.tar" ]; then
    tar -C "$BD" -cf - src server package.json package-lock.json public/index.html 2>/dev/null|tar -C "$APP" -xf - 2>/dev/null
  fi
  # 分支指针也要退回去，否则 HEAD 停在新提交、文件却是旧的，
  # 下次运行会误判"已是最新"。用 update-ref 而非 reset（reset 属红线）。
  HB=$(cat "$BD/head-before.txt" 2>/dev/null||echo "")
  if [ -n "$HB" ]; then
    CUR=$(git rev-parse HEAD 2>/dev/null||echo "")
    if git update-ref "refs/heads/$BR" "$HB" "$CUR" 2>/dev/null; then ok "  分支指针已回退到 ${HB:0:7}"
    else warn "  分支指针回退失败（文件已还原，HEAD 仍在 $CUR）"; fi
  fi
  rm -rf "$STAGE"; systemctl restart $SVC 2>/dev/null
  wait_h 15&&ok "✓ 回滚成功，站点已恢复(HTTP 200)"||bad "✗ 回滚后仍不健康，备份在 $BD"
  bad "备份: $BD"; exit 1; }

# 1 前置
step "1/7 前置检查"
command -v git>/dev/null||die "缺 git"; command -v node>/dev/null||die "缺 node"
git rev-parse --git-dir>/dev/null 2>&1||die "非 Git 仓库"
DRY=0; for a in "$@"; do case "$a" in --dry-run) DRY=1;; esac; done
D=$(git status --porcelain -- src server public/index.html package.json package-lock.json 2>/dev/null|grep -c .||true)
git fetch origin "$BR" --quiet 2>/dev/null||true
if [ "$DRY" = 1 ]; then
  [ "$D" = 0 ] && ok "工作区干净" || warn "工作区有 $D 个未提交改动（正式更新时会先存档再清理）"
elif [ "$D" != 0 ]; then
  warn "本地有 $D 个未提交改动，先存档到备份目录"
  mkdir -p "$BD"
  tar -C "$APP" -czf "$BD/local-changes.tar.gz" src server public/index.html package.json package-lock.json 2>/dev/null
  ok "  已存档 $BD/local-changes.tar.gz（回滚时可用它还原）"
  # 逐个文件还原。
  # 根因：`git checkout -- src server public/index.html ...` 里只要有一个 pathspec
  # 在索引中匹配不到（未跟踪/未纳入 sparse-checkout），git 会整条命令失败且不还原
  # 任何文件——它是原子操作。传单个已跟踪文件路径则必定生效，故改为逐文件。
  mapfile -t CHANGED_FILES < <(
    git status --porcelain -- \
      src server public/index.html package.json package-lock.json 2>/dev/null \
    | cut -c4- | grep -v ' -> ' | grep -v '^$'
  )
  for f in "${CHANGED_FILES[@]}"; do
    if git checkout -- "$f" 2>&1 | sed 's/^/    /'; then :; fi
    git diff --quiet -- "$f" 2>/dev/null || warn "  仍改动: $f"
  done
  R=$(git status --porcelain -- src server public/index.html package.json package-lock.json 2>/dev/null|grep -c .||true)
  if [ "$R" != 0 ]; then
    bad "  清理未完全成功($R 项)："
    git status --porcelain -- src server public/index.html package.json package-lock.json|sed 's/^/    /'
    die "请先人工清理后再更新（已存档，不丢数据）"
  fi
  ok "  工作区已干净"
fi
FP0="$(fp)"; N0="$(fc)"; ok "Node $(node -v) | FDS $N0 个文件 | 指纹 ${FP0:0:12}"

# 2 拉取+分支对齐
step "2/7 拉取远端 $BR"
git fetch origin "$BR" --prune 2>&1|sed 's/^/  /'
R="origin/$BR"; RS=$(git rev-parse --short $R); LB=$(git rev-parse --abbrev-ref HEAD)
ok "本地 $LB@$(git rev-parse --short HEAD) → 远端 $BR@$RS"
if [ "$LB" != "$BR" ]&&[ "$DRY" = 0 ]; then
  if git rev-parse --verify --quiet "$BR">/dev/null 2>&1; then git switch "$BR" 2>&1|sed 's/^/    /'
  elif [ "$(git rev-list --count "$BR..HEAD" 2>/dev/null||echo 0)" = 0 ]; then git branch -m "$BR" 2>&1|sed 's/^/    /'
  else warn "本地有独有提交，不改名，仅对比"; fi
fi
[ "$RS" = "$(git rev-parse --short HEAD)" ]&&{ ok "已是最新"; exit 0; }

# 3 安全闸
step "3/7 安全闸"
TP=$(git diff --name-only HEAD $R -- "$PROT" 2>/dev/null|grep -c .||true)
[ "$TP" != 0 ]&&{ git diff --name-only HEAD $R -- "$PROT"|head -10|sed 's/^/    /'; die "远端改了受保护的 $PROT，需人工确认"; }
ok "远端未触碰 FDS 资产"
CH=$(git diff --name-only HEAD $R -- . ":(exclude)$PROT" ":(exclude)$PROT/**" 2>/dev/null|grep -c .||true)
ok "待更新代码文件 $CH 个"
[ "$CH" = 0 ]&&{ ok "代码区无差异"; exit 0; }
git diff --stat HEAD $R -- . ":(exclude)$PROT" ":(exclude)$PROT/**"|sed 's/^/  /'

if [ "$DRY" = 1 ]; then
  echo; warn "── dry-run 结束：以上是将会发生的改动，未做任何修改 ──"
  echo "  确认无误后执行：sudo $0"
  exit 0
fi

# 4 备份
step "4/7 备份"
mkdir -p "$BD"
tar -C "$APP" -cf "$BD/code.tar" src server package.json package-lock.json public/index.html 2>/dev/null
[ -d "$APP/dist" ]&&{ cp -al "$APP/dist" "$BD/dist" 2>/dev/null||cp -a "$APP/dist" "$BD/dist"; }
git rev-parse HEAD>"$BD/head-before.txt"; echo "$FP0">"$BD/fp-before.txt"
FG=$(df -BG --output=avail "$APP" 2>/dev/null|tail -1|tr -dc '0-9')
[ -n "$FG" ]&&[ "$FG" -lt 6 ]&&die "磁盘仅 ${FG}GB，不足以构建(未改动任何文件)"
ok "备份完成 → $BD | 磁盘可用 ${FG}G"

# 5 同步
step "5/7 同步源码"
git merge --ff-only $R 2>&1|sed 's/^/  /'||die "快进合并失败(未改动文件)"
ok "源码已同步到 $RS"
[ "$(fp)" = "$FP0" ]||rollback "同步后 FDS 资产变化!"
ok "FDS 资产校验通过($(fc) 个文件未变)"

# 6 构建
step "6/7 构建(暂存目录)"
rm -rf "$STAGE"
HB=$(cat "$BD/head-before.txt" 2>/dev/null||echo "")
# 用备份时记录的确定 commit 比对，不用 HEAD@{1}（依赖 reflog，不可靠）
if [ -n "$HB" ]&&! git diff --quiet "$HB" HEAD -- package-lock.json 2>/dev/null; then
  echo "  依赖有变，执行 npm ci"; npm ci --include=dev>>"$BD/build.log" 2>&1||rollback "npm ci 失败"
fi
{ npx tsc -b --pretty false && npx vite build --outDir "$STAGE" --emptyOutDir; }>>"$BD/build.log" 2>&1
[ $? = 0 ]&&[ -f "$STAGE/index.html" ]||{ bad "构建失败:"; tail -20 "$BD/build.log"|sed 's/^/    /'; rm -rf "$STAGE"; rollback "构建失败"; }
ok "构建成功"
rm -rf "$APP/dist.__old__"; mv "$APP/dist" "$APP/dist.__old__" && mv "$STAGE" "$APP/dist"||rollback "dist 换名失败"
rm -rf "$APP/dist.__old__" & ok "dist 已上线"

# 7 验证
step "7/7 重启验证"
systemctl restart $SVC||rollback "重启失败"
wait_h 15||{ journalctl -u $SVC -n 15 --no-pager 2>/dev/null|sed 's/^/    /'; rollback "健康检查未通过"; }
[ "$(fp)" = "$FP0" ]||rollback "上线后 FDS 资产变化!"
ok "✓ HTTP 200"
find "$BK" -maxdepth 1 -name 'upd-*' -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
echo; ok "════ 更新成功 ════"; ok " $(git rev-parse --short "$BR" 2>/dev/null||git rev-parse --short HEAD) | $CH 个文件 | FDS $(fc) 个完好"; ok " 备份 $BD"; ok "════════════════════"; exit 0