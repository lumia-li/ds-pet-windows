# 生成安装程序需要的图形资源：
#   assets/installer/logo.ico   多尺寸图标（Inno 的 SetupIconFile 只吃 .ico）
#   assets/installer/banner.bmp 安装界面顶部横幅（按参考图还原：浅蓝渐变 + 圆角 logo + 标题）
#   assets/installer/side.bmp   完成页/许可页备用小图（同风格，暂时保留）
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-installer-assets.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# packaging\scripts -> 上两级是 dsh-pet-main；npm 项目本体在它的 dsh-pet 子目录里
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$project = Join-Path $root 'dsh-pet'
$outDir = Join-Path $root 'packaging\assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$logoPath = Join-Path $project 'assets\logo-rounded.png'
$fontFile = (Get-ChildItem (Join-Path $project 'assets\fonts') -Filter *.ttf | Select-Object -First 1).FullName
if (-not (Test-Path $logoPath)) { throw "缺少 logo: $logoPath" }
if (-not $fontFile) { throw '缺少字体文件' }

# ---------------- 1) 多尺寸 ICO（PNG 条目，Vista+ 支持） ----------------
# 应用图标：用原始头像 assets/logo.png 做**满幅 + 圆角**。
# 为什么不用 logo-rounded.png：那张是"白色圆角底 + 中间小头像"，缩到任务栏的 32px 后
# 头像只剩一个小点，深色任务栏上看起来就是个空框（用户截图就是这个现象）。
$avatarPath = Join-Path $project 'assets\logo.png'
$appIconPath = Join-Path $outDir 'app-icon.png'
$iconSize = 256
$avatarImg = [System.Drawing.Bitmap]::FromFile($avatarPath)
$appIcon = New-Object System.Drawing.Bitmap($iconSize, $iconSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$ag = [System.Drawing.Graphics]::FromImage($appIcon)
$ag.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$ag.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$ag.Clear([System.Drawing.Color]::Transparent)
$rr = 58; $rd = $rr * 2
$clip = New-Object System.Drawing.Drawing2D.GraphicsPath
$clip.AddArc(0, 0, $rd, $rd, 180, 90)
$clip.AddArc($iconSize - $rd, 0, $rd, $rd, 270, 90)
$clip.AddArc($iconSize - $rd, $iconSize - $rd, $rd, $rd, 0, 90)
$clip.AddArc(0, $iconSize - $rd, $rd, $rd, 90, 90)
$clip.CloseFigure()
$ag.SetClip($clip)
$ag.DrawImage($avatarImg, 0, 0, $iconSize, $iconSize)
$ag.ResetClip()
$ag.Dispose(); $clip.Dispose(); $avatarImg.Dispose()

# 右下角「下载」角标：青色圆底 + 白色向下箭头（一眼看出这是"安装/下载"用的图标）
$ag2 = [System.Drawing.Graphics]::FromImage($appIcon)
$ag2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$badgeR = [single]($iconSize * 0.235)
$cx = [single]($iconSize - $badgeR - $iconSize * 0.015)
$cy = [single]($iconSize - $badgeR - $iconSize * 0.015)
# 白色描边，把角标从头像上"托"起来
$ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single]($iconSize * 0.022))
$ag2.DrawEllipse($ringPen, $cx - $badgeR, $cy - $badgeR, $badgeR * 2, $badgeR * 2)
$ringPen.Dispose()
$badgeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 111, 207, 192))
$ag2.FillEllipse($badgeBrush, $cx - $badgeR, $cy - $badgeR, $badgeR * 2, $badgeR * 2)
$badgeBrush.Dispose()
# 向下箭头：竖杆 + 两条斜边
$arrowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single]($badgeR * 0.3))
$arrowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$arrowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$ag2.DrawLine($arrowPen, $cx, ($cy - $badgeR * 0.52), $cx, ($cy + $badgeR * 0.30))
$ag2.DrawLine($arrowPen, ($cx - $badgeR * 0.40), ($cy + $badgeR * 0.02), $cx, ($cy + $badgeR * 0.42))
$ag2.DrawLine($arrowPen, ($cx + $badgeR * 0.40), ($cy + $badgeR * 0.02), $cx, ($cy + $badgeR * 0.42))
$arrowPen.Dispose()
$ag2.Dispose()

$appIcon.Save($appIconPath, [System.Drawing.Imaging.ImageFormat]::Png)
$appIcon.Dispose()
Write-Host "APPICON -> $appIconPath"

$src = [System.Drawing.Bitmap]::FromFile($appIconPath)

# 原图四周是透明圆角，直接缩放的话小尺寸里头像只占中间一小块 ——
# 任务栏（32×32）在深色底上就变成"一个空框"。先算出非透明边界，再按边界满版缩放。
$minX = $src.Width; $minY = $src.Height; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $src.Height; $y++) {
  for ($x = 0; $x -lt $src.Width; $x++) {
    if ($src.GetPixel($x, $y).A -gt 24) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -le $minX -or $maxY -le $minY) { $minX = 0; $minY = 0; $maxX = $src.Width - 1; $maxY = $src.Height - 1 }
$cropW = $maxX - $minX + 1
$cropH = $maxY - $minY + 1
# 取正方形边长（取大的一边并居中），避免拉伸变形
$side = [Math]::Max($cropW, $cropH)
$cropX = $minX - [int](($side - $cropW) / 2)
$cropY = $minY - [int](($side - $cropH) / 2)
Write-Host "LOGO crop -> ($cropX,$cropY) ${side}px (from ${cropW}x${cropH})"

# 尺寸要覆盖各种 DPI：桌面 16、任务栏 24/32（125%/150% 缩放下是 20/24/40）、
# 大图标视图 48/64/96/128，另加 256。缺了某一档，Windows 会退回 exe 的默认图标。
$sizes = @(256, 128, 96, 64, 48, 40, 32, 24, 20, 16)
$items = @()
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $srcRect = New-Object System.Drawing.Rectangle($cropX, $cropY, $side, $side)
  $dstRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $items += , @($size, $ms.ToArray())
  $bmp.Dispose(); $ms.Dispose()
}
$src.Dispose()

$icoPath = Join-Path $outDir 'logo.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$items.Count)
$offset = 6 + 16 * $items.Count
foreach ($item in $items) {
  $size = [int]$item[0]; $data = [byte[]]$item[1]
  $b = if ($size -ge 256) { 0 } else { $size }
  $bw.Write([Byte]$b); $bw.Write([Byte]$b); $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($item in $items) { $bw.Write([byte[]]$item[1]) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Host "ICO  -> $icoPath ($($items.Count) sizes)"

# ---------------- 2) 背景图（两张：整窗 background.bmp + 横幅 banner.bmp） ----------------
# 同一套画法，两种尺寸：
#   · background.bmp 1000×620 → 安装窗口的整张底图（logo/标题在左上，右侧留白给内容与按钮）
#   · banner.bmp      860×300 → 保留的横幅版本（其它地方可按需用）
# 字体：软糖体（PrivateFontCollection 只在本次绘制里用，不装系统）
$pfc = New-Object System.Drawing.Text.PrivateFontCollection
$pfc.AddFontFile($fontFile)
$family = $pfc.Families[0]

# 中文标题用 base64 传进来：本脚本是 UTF-8 无 BOM，PowerShell 5.1 会按 ANSI 读，字面量会乱码
$subTitle = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('5a6J6KOF56iL5bqP'))
# "选择"：同样用 base64 传，避免 UTF-8 无 BOM 被按 ANSI 读成乱码
$PickText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('6YCJ5oup'))
# "安装到"：路径框上方的小标题
$PathLabel = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('5a6J6KOF5Yiw'))

function Draw-OutlinedText {
  param($Graphics, [string]$Text, [single]$Size, [System.Drawing.Color]$Fill, [single]$X, [single]$Y, [single]$Stroke)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Near
  $path.AddString($Text, $family, [int][System.Drawing.FontStyle]::Regular, $Size, (New-Object System.Drawing.PointF($X, $Y)), $fmt)
  # 先描白边（用 Pen 的 Round 连接，避免尖角），再填充主色
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $Stroke)
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $Graphics.DrawPath($pen, $path)
  $brush = New-Object System.Drawing.SolidBrush($Fill)
  $Graphics.FillPath($brush, $path)
  $pen.Dispose(); $brush.Dispose(); $path.Dispose(); $fmt.Dispose()
}

function New-InstallerBackdrop {
  param(
    [string]$Name,
    [int]$W,
    [int]$H,
    [single]$Scale,
    # 左上角 logo 方块的边长（整窗版放大到 108，横幅版保持 74）
    [int]$LogoBox = 74,
    # 「ds-pet」标题的基线 Y（logo 放大后文字随之下移）
    [single]$TitleY = 104,
    # 页面标题 / 正文（画在右侧渐变上；安装位置页等由界面控件补内容）
    [string]$Title = '',
    [string]$Body = '',
    # 是否画"路径框 + 选择按钮"（只给安装位置页用）
    [bool]$PathBox = $false,
    # 是否画"进度状态白条"（只给安装中页用：Inno 的状态/文件两行文字本身不透明，给它们一块白底）
    [bool]$StatusBox = $false,
    # 附加选项页的条目文字（画在背景上，勾选框由界面上的小图标叠上去）
    [string[]]$Items = @()
  )
  $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  # 渐变底：左上偏蓝 -> 右下近白（参考图右上是更亮的白）
  $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 168, 209, 232), [System.Drawing.Color]::FromArgb(255, 248, 251, 253), 35)
  $g.FillRectangle($grad, $rect)
  # 右上再叠一层柔光，贴近参考图的"右上更白"
  $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glow.AddEllipse([int]($W * 0.45), [int](-$H * 0.9), [int]($W * 1.1), [int]($H * 1.9))
  $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)
  $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(150, 255, 255, 255)
  $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
  $g.FillPath($glowBrush, $glow)
  $grad.Dispose(); $glowBrush.Dispose(); $glow.Dispose()

  # 左上：白色圆角方块 + 头像（尺寸与坐标都按 $Scale 缩放）
  $box = [int]($LogoBox * $Scale); $bx = [int](26 * $Scale); $by = [int](20 * $Scale)
  $radius = [int]($box * 0.24)
  $logoImg = [System.Drawing.Image]::FromFile($logoPath)
  $rounded = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $rounded.AddArc($bx, $by, $d, $d, 180, 90)
  $rounded.AddArc($bx + $box - $d, $by, $d, $d, 270, 90)
  $rounded.AddArc($bx + $box - $d, $by + $box - $d, $d, $d, 0, 90)
  $rounded.AddArc($bx, $by + $box - $d, $d, $d, 90, 90)
  $rounded.CloseFigure()
  $state = $g.Save()
  $g.SetClip($rounded)
  $g.FillRectangle([System.Drawing.Brushes]::White, $bx, $by, $box, $box)
  $pad = [int](4 * $Scale)
  $g.DrawImage($logoImg, $bx + $pad, $by + $pad, $box - $pad * 2, $box - $pad * 2)
  $g.Restore($state)
  $logoImg.Dispose()
  $rounded.Dispose()

  # 页面文字（标题 + 正文）直接画在渐变上 —— 不用白底卡片，也不用界面控件去显示文字
  # （界面控件要么不透明（TNewStaticText 带白块），要么字距被拉宽（TLabel），
  #   画进图里最省事，字距用 GDI+ 渲染，和左上角的 ds-pet 标题同一套观感）
  if ($Title -or $Body) {
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $tf = New-Object System.Drawing.Font($family, [single]21, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
    $tBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 47, 127, 168))
    if ($Title) { $g.DrawString($Title, $tf, $tBrush, [single](380 * $Scale), [single](46 * $Scale)) }
    $tf.Dispose(); $tBrush.Dispose()

    if ($Body) {
      $bf = New-Object System.Drawing.Font($family, [single]13, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
      $bBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 46, 58))
      $rectF = New-Object System.Drawing.RectangleF([single](382 * $Scale), [single](92 * $Scale), [single](570 * $Scale), [single](300 * $Scale))
      $sf = New-Object System.Drawing.StringFormat
      $sf.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
      $g.DrawString($Body, $bf, $bBrush, $rectF, $sf)
      $bf.Dispose(); $bBrush.Dispose(); $sf.Dispose()
    }
  }

  # 附加选项条目（只给附加选项页画）：文字直接画在渐变上，字距与标题一致；
  # 左侧留出 24px 给勾选小图标（运行时由界面用图片叠上去，可点击切换）。
  if ($Items.Count -gt 0) {
    $iy = 186
    $if2 = New-Object System.Drawing.Font($family, [single]12, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
    $ib2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 46, 58))
    foreach ($item in $Items) {
      $g.DrawString($item, $if2, $ib2, [single]412, [single]($iy - 2))
      $iy += 40
    }
    $if2.Dispose(); $ib2.Dispose()
  }

  # 进度槽（只给安装中页画）：原生 ProgressGauge 是系统主题的绿色方块，和这套配色不搭。
  # 这里画一条浅色圆角凹槽，运行时在它上面叠一块青绿填充（宽度按进度变化）。
  if ($StatusBox) {
    $tx = 380; $ty = 138; $tw = 580; $th = 14; $tr = 7
    $tp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $td = $tr * 2
    $tp.AddArc($tx, $ty, $td, $td, 180, 90)
    $tp.AddArc($tx + $tw - $td, $ty, $td, $td, 270, 90)
    $tp.AddArc($tx + $tw - $td, $ty + $th - $td, $td, $td, 0, 90)
    $tp.AddArc($tx, $ty + $th - $td, $td, $td, 90, 90)
    $tp.CloseFigure()
    $tb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 226, 238, 246))
    $g.FillPath($tb, $tp)
    $tpen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 196, 220, 235), 1)
    $g.DrawPath($tpen, $tp)
    $tb.Dispose(); $tpen.Dispose(); $tp.Dispose()
  }

  # 路径框（只给安装位置页画）：上方小标题 + 白色圆角输入框 + 右侧「选择」按钮
  if ($PathBox) {
    $lf = New-Object System.Drawing.Font($family, [single]11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
    $lb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 72, 92, 105))
    $g.DrawString($PathLabel, $lf, $lb, [single]382, [single]156)
    $lf.Dispose(); $lb.Dispose()

    $pxBox = 380; $pyBox = 186; $pwBox = 512; $phBox = 38
    $boxPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bd = 12
    $boxPath.AddArc($pxBox, $pyBox, $bd, $bd, 180, 90)
    $boxPath.AddArc($pxBox + $pwBox - $bd, $pyBox, $bd, $bd, 270, 90)
    $boxPath.AddArc($pxBox + $pwBox - $bd, $pyBox + $phBox - $bd, $bd, $bd, 0, 90)
    $boxPath.AddArc($pxBox, $pyBox + $phBox - $bd, $bd, $bd, 90, 90)
    $boxPath.CloseFigure()
    $boxBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
    $g.FillPath($boxBrush, $boxPath)
    $boxPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 150, 195, 215), 1)
    $g.DrawPath($boxPen, $boxPath)
    $boxBrush.Dispose(); $boxPen.Dispose(); $boxPath.Dispose()

    # 右侧「选择…」按钮
    $bx2 = 902; $by2 = 186; $bw2 = 78; $bh2 = 38
    $btnPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $btnPath.AddArc($bx2, $by2, $bd, $bd, 180, 90)
    $btnPath.AddArc($bx2 + $bw2 - $bd, $by2, $bd, $bd, 270, 90)
    $btnPath.AddArc($bx2 + $bw2 - $bd, $by2 + $bh2 - $bd, $bd, $bd, 0, 90)
    $btnPath.AddArc($bx2, $by2 + $bh2 - $bd, $bd, $bd, 90, 90)
    $btnPath.CloseFigure()
    $btnBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 214, 236, 246))
    $g.FillPath($btnBrush, $btnPath)
    $btnPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 150, 195, 215), 1)
    $g.DrawPath($btnPen, $btnPath)
    $btnBrush.Dispose(); $btnPen.Dispose(); $btnPath.Dispose()

    $bf2 = New-Object System.Drawing.Font($family, [single]11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
    $bb2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 47, 90, 115))
    $sf2 = New-Object System.Drawing.StringFormat
    $sf2.Alignment = [System.Drawing.StringAlignment]::Center
    $sf2.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString($PickText, $bf2, $bb2, (New-Object System.Drawing.RectangleF([single]$bx2, [single]$by2, [single]$bw2, [single]$bh2)), $sf2)
    $bf2.Dispose(); $bb2.Dispose(); $sf2.Dispose()
  }

  # 标题：ds-pet / 安装程序（在 logo 下方，位置随 -TitleY 下移）
  Draw-OutlinedText -Graphics $g -Text 'ds-pet' -Size ([single](62 * $Scale)) -Fill ([System.Drawing.Color]::FromArgb(255, 122, 209, 196)) -X ([single](30 * $Scale)) -Y ([single]($TitleY * $Scale)) -Stroke ([single](7 * $Scale))
  Draw-OutlinedText -Graphics $g -Text $subTitle -Size ([single](34 * $Scale)) -Fill ([System.Drawing.Color]::FromArgb(255, 150, 183, 206)) -X ([single](32 * $Scale)) -Y ([single](($TitleY + 72) * $Scale)) -Stroke ([single](6 * $Scale))

  $g.Dispose()
  $bmpPath = Join-Path $outDir $Name
  $bmp.Save($bmpPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  # 同时存一份 PNG 供预览（BMP 的通道顺序在部分看图器里会红蓝互换，看着会发暖）
  $bmp.Save((Join-Path $outDir ($Name -replace '\.bmp$', '-preview.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "BACKDROP -> $bmpPath ($W x $H)"
}

# 整窗背景（无文字版：按钮底图从这里采样）
New-InstallerBackdrop -Name 'background.bmp' -W 1000 -H 620 -Scale 1.0 -LogoBox 108 -TitleY 168
# 横幅版本（保留：860×300，按参考图比例）
New-InstallerBackdrop -Name 'banner.bmp' -W 860 -H 300 -Scale 0.86 -LogoBox 74 -TitleY 104

# 每页一张背景：页面标题/正文直接画在渐变上（不用界面控件，避免白底与字距问题）
$pagesPath = Join-Path $root 'packaging\installer\pages.json'
$pages = Get-Content -Path $pagesPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($key in @('welcome', 'dir', 'tasks', 'installing', 'finished')) {
  $page = $pages.$key
  $items = @()
  if ($page.PSObject.Properties.Name -contains 'items' -and $page.items) { $items = @($page.items) }
  New-InstallerBackdrop -Name "bg-$key.bmp" -W 1000 -H 620 -Scale 1.0 -LogoBox 108 -TitleY 168 `
    -Title $page.title -Body $page.body -PathBox ($key -eq 'dir') -StatusBox ($key -eq 'installing') -Items $items
}

# ---------------- 3) 按钮底图（圆角，文字由界面上的透明标签叠加） ----------------
# Inno 的 TButton 无法着色，所以按钮 = TImage(底图) + TLabel(透明文字) + OnClick。
function New-RoundedButton {
  param(
    [string]$Path,
    [int]$W,
    [int]$H,
    [System.Drawing.Color]$Fill,
    [System.Drawing.Color]$Border,
    [int]$BorderWidth,
    # 从整窗背景的对应位置采样一块做底：圆角外面就是真实背景，看不出接缝
    [string]$BackdropPath = '',
    [int]$SrcX = 0,
    [int]$SrcY = 0
  )
  $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  # VCL 的 TBitmap 不认 alpha（透明会被画成黑色），所以圆角外面必须填"实际背景"：
  # 给了底图就从底图同位置裁一块，没给才用纯色兜底。
  if ($BackdropPath -and (Test-Path $BackdropPath)) {
    $src = [System.Drawing.Image]::FromFile($BackdropPath)
    $srcRect = New-Object System.Drawing.Rectangle($SrcX, $SrcY, $W, $H)
    $dstRect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
    $g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $src.Dispose()
  } else {
    $g.Clear([System.Drawing.Color]::FromArgb(255, 247, 251, 250))
  }
  $r = 12
  $d = $r * 2
  $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path2.AddArc(0, 0, $d, $d, 180, 90)
  $path2.AddArc($W - $d, 0, $d, $d, 270, 90)
  $path2.AddArc($W - $d, $H - $d, $d, $d, 0, 90)
  $path2.AddArc(0, $H - $d, $d, $d, 90, 90)
  $path2.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush($Fill)
  $g.FillPath($brush, $path2)
  if ($BorderWidth -gt 0) {
    $pen = New-Object System.Drawing.Pen($Border, $BorderWidth)
    $g.DrawPath($pen, $path2)
    $pen.Dispose()
  }
  $brush.Dispose(); $path2.Dispose(); $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
}

$w1 = 132; $h1 = 40; $w2 = 110; $h2 = 40
$bd = Join-Path $outDir 'background.bmp'
# 主按钮在右下 (834,550)，取消在左下 (34,550)，上一步 (714,550) —— 与 ds-pet.iss 的 RefreshUi 保持一致
New-RoundedButton -Path (Join-Path $outDir 'btn-primary.bmp') -W $w1 -H $h1 -Fill ([System.Drawing.Color]::FromArgb(255, 111, 207, 192)) -Border ([System.Drawing.Color]::FromArgb(0, 0, 0, 0)) -BorderWidth 0 -BackdropPath $bd -SrcX 834 -SrcY 550
New-RoundedButton -Path (Join-Path $outDir 'btn-ghost-cancel.bmp') -W $w2 -H $h2 -Fill ([System.Drawing.Color]::FromArgb(255, 255, 255, 255)) -Border ([System.Drawing.Color]::FromArgb(255, 196, 220, 232)) -BorderWidth 1 -BackdropPath $bd -SrcX 34 -SrcY 550
New-RoundedButton -Path (Join-Path $outDir 'btn-ghost-back.bmp') -W $w2 -H $h2 -Fill ([System.Drawing.Color]::FromArgb(255, 255, 255, 255)) -Border ([System.Drawing.Color]::FromArgb(255, 196, 220, 232)) -BorderWidth 1 -BackdropPath $bd -SrcX 714 -SrcY 550
# 勾选框（22×22）：未勾=白底灰边，已勾=青绿底白勾；底色都采自背景同一位置
New-RoundedButton -Path (Join-Path $outDir 'check-off.bmp') -W 22 -H 22 -Fill ([System.Drawing.Color]::FromArgb(255, 255, 255, 255)) -Border ([System.Drawing.Color]::FromArgb(255, 150, 176, 196)) -BorderWidth 1 -BackdropPath $bd -SrcX 380 -SrcY 186
New-RoundedButton -Path (Join-Path $outDir 'check-on-raw.bmp') -W 22 -H 22 -Fill ([System.Drawing.Color]::FromArgb(255, 111, 207, 192)) -Border ([System.Drawing.Color]::FromArgb(0, 0, 0, 0)) -BorderWidth 0 -BackdropPath $bd -SrcX 380 -SrcY 186
$ck = [System.Drawing.Bitmap]::FromFile((Join-Path $outDir 'check-on-raw.bmp'))
$cg = [System.Drawing.Graphics]::FromImage($ck)
$cg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$cp = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 2.4)
$cp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$cp.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$cg.DrawLine($cp, 5.5, 11.5, 9.5, 15.5)
$cg.DrawLine($cp, 9.5, 15.5, 16.5, 6.5)
$cp.Dispose(); $cg.Dispose()
$ck.Save((Join-Path $outDir 'check-on.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$ck.Dispose()
Remove-Item (Join-Path $outDir 'check-on-raw.bmp') -Force -ErrorAction SilentlyContinue

Write-Host "BUTTONS -> $outDir (3 bitmaps + 2 check icons)"
