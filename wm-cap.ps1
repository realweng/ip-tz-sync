param([int]$TargetPid, [string]$Out = "D:\workspace\git\timezone\wm-window.png")
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WC {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$target = $TargetPid
$hwnd = [IntPtr]::Zero
$cb = [WC+EnumProc]{
  param($h, $l)
  $wpid = 0
  [void][WC]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($wpid -eq $target -and [WC]::IsWindowVisible($h)) { $script:hwnd = $h; return $false }
  return $true
}
[void][WC]::EnumWindows($cb, [IntPtr]::Zero)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "no visible window"; exit 1 }
$r = New-Object WC+RECT
[void][WC]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][WC]::PrintWindow($hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "captured ${w}x${h} -> $Out"
