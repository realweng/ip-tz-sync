# ip-tz-sync 桌面水印: 右下角显示 实际地区真实时间 + 系统指纹时区
# 由 cli.js 经 WMI 以隐藏方式启动; 透明/无边框/置顶/鼠标穿透
param(
  [string]$ZoneMapPath = "",
  [string]$RealWinTzId = "",   # 实际地区 (直连 IP) 的 Windows 时区 ID
  [string]$RealIana = ""       # 实际地区的 IANA 名称, 仅用于显示
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@

# Windows 时区 ID -> IANA 名称 (由 cli.js 传入 win-zones.json 路径)
$script:map = @{}
if ($ZoneMapPath -and (Test-Path $ZoneMapPath)) {
  try {
    $raw = Get-Content $ZoneMapPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $raw.PSObject.Properties) {
      $w = $p.Value.d
      if ($w -and -not $script:map.Contains($w)) { $script:map[$w] = $p.Name }
    }
  } catch { }
}

# 实际地区时区对象; 查找失败则回退为系统时区
$realTz = $null
if ($RealWinTzId) {
  try { $realTz = [TimeZoneInfo]::FindSystemTimeZoneById($RealWinTzId) } catch { }
}
if (-not $realTz) { $realTz = [TimeZoneInfo]::Local }

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" SizeToContent="WidthAndHeight">
  <Border Background="#99000000" CornerRadius="8" Padding="12,7">
    <StackPanel>
      <TextBlock Name="TimeText" Foreground="White" FontFamily="Consolas" FontSize="20" FontWeight="Bold"/>
      <TextBlock Name="RealText" Foreground="#FFBBBBBB" FontFamily="Consolas" FontSize="11" Margin="0,1,0,0"/>
      <TextBlock Name="SysText" Foreground="#FF888888" FontFamily="Consolas" FontSize="11" Margin="0,1,0,0"/>
    </StackPanel>
  </Border>
</Window>
"@

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader ([xml]$xaml)))
$timeText = $win.FindName("TimeText")
$realText = $win.FindName("RealText")
$sysText = $win.FindName("SysText")

$win.Add_Loaded({
  # WS_EX_LAYERED | WS_EX_TRANSPARENT (鼠标穿透) | WS_EX_TOOLWINDOW (不出现在 Alt+Tab)
  $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper $win).Handle
  $ex = [Win32]::GetWindowLong($hwnd, -20)
  [void][Win32]::SetWindowLong($hwnd, -20, ($ex -bor 0x80020 -bor 0x80))
})

function Set-WatermarkPos {
  # 文本填充后宽度才确定, 每次刷新后重新贴右下角
  $win.UpdateLayout()
  $wa = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Right - $win.ActualWidth - 12
  $win.Top = $wa.Bottom - $win.ActualHeight - 12
}

function Format-Zone($tz, $now, $iana) {
  $off = $tz.GetUtcOffset($now)
  $sign = if ($off.TotalMinutes -ge 0) { "+" } else { "-" }
  $abs = [TimeSpan]::FromSeconds([math]::Abs($off.TotalSeconds))
  return ("{0} (UTC{1}{2:d2}:{3:d2})" -f $iana, $sign, [int]$abs.TotalHours, $abs.Minutes)
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({
  [TimeZoneInfo]::ClearCachedData()
  $utc = [DateTimeOffset]::UtcNow
  # 主行: 实际地区真实时间
  $realNow = [TimeZoneInfo]::ConvertTime($utc, $realTz)
  $timeText.Text = $realNow.ToString("yyyy-MM-dd  HH:mm:ss")
  $realLabel = if ($RealIana) { $RealIana } else { $realTz.Id }
  $realText.Text = "实际 " + (Format-Zone $realTz $realNow $realLabel)
  # 副行: 系统时区 (网站指纹看到的)
  $sysTz = [TimeZoneInfo]::Local
  $sysNow = [TimeZoneInfo]::ConvertTime($utc, $sysTz)
  $sysIana = $script:map[$sysTz.Id]
  if (-not $sysIana) { $sysIana = $sysTz.Id }
  $sysText.Text = "系统 " + (Format-Zone $sysTz $sysNow $sysIana)
  Set-WatermarkPos
})
$timer.Start()
Set-WatermarkPos
[void]$win.ShowDialog()
