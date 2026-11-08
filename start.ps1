param([switch]$Quiet)

$ErrorActionPreference = "Stop"

# -Quiet: 无窗口后台跑，不打字、不等回车（给「后台启动.vbs」用）

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Say($msg, $color) {
  if (-not $Quiet) { Write-Host $msg -ForegroundColor $color }
}

# 找 node：环境变量 > 项目内 node\ > PATH > node-path.txt（本机记的路径）
$node = $null
if ($env:RING_NODE -and (Test-Path $env:RING_NODE)) { $node = $env:RING_NODE }
if (-not $node) {
  $local = Join-Path $PSScriptRoot "node\node.exe"
  if (Test-Path $local) { $node = $local }
}
if (-not $node) {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { $node = $c.Source }
}
if (-not $node) {
  $hint = Join-Path $PSScriptRoot "node-path.txt"
  if (Test-Path $hint) {
    $p = (Get-Content $hint -Raw -Encoding UTF8).Trim()
    if ($p -and (Test-Path $p)) { $node = $p }
  }
}
if (-not $node) {
  Say "" "Yellow"
  Say "  找不到 Node.js。" "Yellow"
  Say "  装一个 Node 22.5 以上的版本（https://nodejs.org），或者：" "Yellow"
  Say "    - 把 node.exe 放进本目录的 node\ 文件夹，或" "Yellow"
  Say "    - 在本目录新建 node-path.txt，里面写 node.exe 的完整路径，或" "Yellow"
  Say "    - 设环境变量 RING_NODE 指向 node.exe" "Yellow"
  Say "" "Yellow"
  if (-not $Quiet) { Read-Host "按回车关闭" }
  exit 1
}

# 已经在跑就别再起一个
$busy = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  if (-not $Quiet) {
    Say "" "Yellow"
    Say "  面板已经在运行了，直接打开浏览器。" "Yellow"
    Start-Process "http://127.0.0.1:5173/"
    Read-Host "按回车关闭这个窗口"
  }
  exit 0
}

Say "" "Cyan"
Say "  环形的心 - 记忆面板" "Cyan"
Say "  =========================================" "DarkGray"
Say "  地址: http://127.0.0.1:5173"
if ($Quiet) {
  Say "  后台静默运行：不开浏览器、不弹窗（页面归海螺控制台管）。" "DarkGray"
} else {
  Say "  三秒后自动打开浏览器"
  Say ""
  Say "  关掉这个窗口 = 关闭面板" "DarkGray"
}
Say ""

# 只有自己双击跑（非 Quiet）才开浏览器；被海螺拉起时保持安静
if (-not $Quiet) {
  Start-Process powershell -ArgumentList @(
    "-NoProfile", "-WindowStyle", "Hidden", "-Command",
    "Start-Sleep 3; Start-Process 'http://127.0.0.1:5173/'"
  ) | Out-Null
}

& $node "$here\src\web\server.js" --port 5173

Say "" "DarkGray"
Say "  服务已停止。" "DarkGray"
if (-not $Quiet) { Read-Host "按回车关闭" }