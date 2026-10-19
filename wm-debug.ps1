Add-Content -Path D:/workspace/git/timezone/wm-debug.log -Value "step: start"
# ip-tz-sync 桌面水印: 右下角显示当前时间 + 时区
# 由 cli.js 以隐藏方式启动; 透明/无边框/置顶/鼠标穿透
param([string]$ZoneMapPath = "")

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase
Add-Content -Path D:/workspace/git/timezone/wm-debug.log -Value "step: assemblies"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@

Add-Content -Path D:/workspace/git/timezone/wm-debug.log -Value "step: add-type done"
# Windows 时区 ID -> IANA 名称 (由 cli.js 传入 win-zones.json 路径)
$script:map = @{}
if ($ZoneMapPath -and (Test-Path $ZoneMapPath)) {
  try {
    $raw = Get-Content $ZoneMapPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $raw.PSObject.Properties) {
      $win = $p.Value.d
      if ($win -and -not $script:map.Contains($win)) { $script:map[$win] = $p.Name }
    }
  } catch { }
}

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" SizeToContent="WidthAndHeight">
  <Border Background="#99000000" CornerRadius="8" Padding="12,7">
    <StackPanel>
      <TextBlock Name="TimeText" Foreground="White" FontFamily="Consolas" FontSize="20" FontWeight="Bold"/>
      <TextBlock Name="ZoneText" Foreground="#FFBBBBBB" FontFamily="Consolas" FontSize="11" Margin="0,1,0,0"/>
    </StackPanel>
  </Border>
</Window>
"@

$winAdd-Content -Path D:/workspace/git/timezone/wm-debug.log -Value "step: before xaml load"
 = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader ([xml]$xaml)))
$timeText = $win.FindName("TimeText")
$zoneText = $win.FindName("ZoneText")

$winAdd-Content -Path D:/workspace/git/timezone/wm-debug.log -Value "step: xaml loaded"
.Add_Loaded({
  # WS_EX_LAYERED | WS_EX_TRANSPARENT (鼠标穿透) | WS_EX_TOOLWINDOW (不出现在 Alt+Tab)
  $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper $win).Handle
  $ex = [Win32]::GetWindowLong($hwnd, -20)
  [void][Win32]::SetWindowLong($hwnd, -20, ($ex -bor 0x80020 -bor 0x80))
  $wa = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Right - $win.ActualWidth - 12
  $win.Top = $wa.Bottom - $win.ActualHeight - 12
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({
  [TimeZoneInfo]::ClearCachedData()
  $tz = [TimeZoneInfo]::Local
  $now = [DateTimeOffset]::Now
  $timeText.Text = $now.ToString("yyyy-MM-dd  HH:mm:ss")
  $iana = $script:map[$tz.Id]
  if (-not $iana) { $iana = $tz.Id }
  $off = $tz.GetUtcOffset($now)
  $sign = if ($off.TotalMinutes -ge 0) { "+" } else { "-" }
  $abs = [TimeSpan]::FromSeconds([math]::Abs($off.TotalSeconds))
  $zoneText.Text = ("{0}  UTC{1}{2:d2}:{3:d2}" -f $iana, $sign, [int]$abs.TotalHours, $abs.Minutes)
})
$timer.Start()
Add-Content -Path D:/workspace/git/timezone/wm-debug.log -Value "step: timer started"
[void]$win.Add-Content -Path D:/workspace/git/timezone/wm-debug.log -Value "step: before showdialog"
ShowDialog()
