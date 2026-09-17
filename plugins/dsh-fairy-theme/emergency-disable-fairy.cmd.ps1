# 紧急禁用 dsh-fairy-theme
#
# 用途：万一 DSH 因本插件显示失败页 / 打不开，**双击同目录的 .cmd 即可恢复**。
# 原理：把插件从 profile 的 bundle 清单里摘掉。只编辑 JSON，**不需要 DSH 能运行**。
# 恢复后 DSH 退回官方原样（主题、浮动形象、音效全部消失）。
#
# 想重新启用：把 profile 目录下的 package.json.bak-fairy 覆盖回 package.json 即可。
#
# ⚠️ 本文件必须保存为 **UTF-8 with BOM**，否则 Windows PowerShell 5.1 会按 GBK
#    解码中文注释并报 "Missing closing '}'"。改动后请用 verify-emergency-script.mjs 校验。

$ErrorActionPreference = 'Stop'

$profileDir = if ($env:FAIRY_PROFILE_DIR) { $env:FAIRY_PROFILE_DIR } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
$pkgPath    = Join-Path $profileDir 'package.json'
$bakPath    = Join-Path $profileDir 'package.json.bak-fairy'
$PLUGIN     = 'dsh-fairy-theme'

$say = { param($m) Write-Host $m }

& $say ''
& $say '=== 紧急禁用 dsh-fairy-theme ==='
& $say ''

if (-not (Test-Path -LiteralPath $pkgPath)) {
    & $say "[错误] 找不到 $pkgPath"
    & $say '       请确认 DSH 的 profile 目录位置。'
    if ($env:FAIRY_NO_PAUSE -ne '1') { Read-Host '按回车退出' }
    exit 1
}

# ---- 1) 备份（每次留一份带时间戳的，避免覆盖掉好的备份）----
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakKeep = Join-Path $profileDir "package.json.bak-fairy-$stamp"
Copy-Item -LiteralPath $pkgPath -Destination $bakKeep -Force
if (-not (Test-Path -LiteralPath $bakPath)) {
    Copy-Item -LiteralPath $pkgPath -Destination $bakPath -Force
}
& $say "[1/3] 已备份：$bakKeep"

# ---- 2) 读取并移除插件登记 ----
$json = (Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8) | ConvertFrom-Json
$removed = @()

foreach ($section in @('dependencies', 'devDependencies')) {
    $node = $json.PSObject.Properties[$section]
    if ($null -ne $node -and $null -ne $node.Value -and $node.Value.PSObject.Properties.Name -contains $PLUGIN) {
        $node.Value.PSObject.Properties.Remove($PLUGIN)
        $removed += $section
    }
}

$bundlesNode = $null
if ($null -ne $json.PSObject.Properties['dsh'] -and $null -ne $json.dsh.PSObject.Properties['profile']) {
    $bundlesNode = $json.dsh.profile.PSObject.Properties['bundles']
}
if ($null -ne $bundlesNode -and $null -ne $bundlesNode.Value) {
    $before = @($bundlesNode.Value).Count
    $kept = @($bundlesNode.Value | Where-Object { $_ -ne $PLUGIN })
    if ($kept.Count -lt $before) {
        $bundlesNode.Value = $kept
        $removed += 'dsh.profile.bundles'
    }
}

if ($removed.Count -gt 0) {
    & $say "[2/3] 已从以下位置移除：$($removed -join ', ')"
} else {
    & $say '[2/3] 未找到登记（可能已经禁用过了）'
}

# ---- 3) 写回（UTF-8 无 BOM，JSON 不需要 BOM）----
$out  = $json | ConvertTo-Json -Depth 20
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($pkgPath, $out, $utf8)
& $say "[3/3] 已写回：$pkgPath"

# ---- 4) 复读校验（「写入」!=「生效」，这里必须复读一遍）----
$check = (Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8) | ConvertFrom-Json
$still = @()
foreach ($section in @('dependencies', 'devDependencies')) {
    $node = $check.PSObject.Properties[$section]
    if ($null -ne $node -and $null -ne $node.Value -and $node.Value.PSObject.Properties.Name -contains $PLUGIN) {
        $still += $section
    }
}
if ($null -ne $check.PSObject.Properties['dsh'] -and $null -ne $check.dsh.PSObject.Properties['profile']) {
    $b = $check.dsh.profile.PSObject.Properties['bundles']
    if ($null -ne $b -and @($b.Value) -contains $PLUGIN) { $still += 'bundles' }
}

& $say ''
if ($still.Count -eq 0) {
    & $say '✅ 已确认摘除干净。现在关闭并重新打开 DSH 即可。'
    & $say ''
    & $say '想恢复本插件：把 package.json.bak-fairy 覆盖回 package.json 即可。'
    if ($env:FAIRY_NO_PAUSE -ne '1') { Read-Host '按回车退出' }
    exit 0
}
& $say "⚠️ 仍残留在：$($still -join ', ') —— 请手动检查该文件。"
if ($env:FAIRY_NO_PAUSE -ne '1') { Read-Host '按回车退出' }
exit 2
